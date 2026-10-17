package musewire

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

var errCredentials = errors.New("muse: invalid paired credentials")

type credentials struct {
	AccessToken        string `json:"access_token"`
	RefreshToken       string `json:"refresh_token"`
	APIURL             string `json:"api_url_v2"`
	NoiseHost          string `json:"noise_host"`
	SavedAt            int64  `json:"access_token_saved_at"`
	deviceID, sdkToken string
	fields             map[string]json.RawMessage
}

var macPattern = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)

func loadCredentials(directory string) (credentials, error) {
	var creds credentials
	data, err := os.ReadFile(filepath.Join(directory, "pairing.json"))
	if err != nil {
		return creds, errCredentials
	}
	if json.Unmarshal(data, &creds) != nil || json.Unmarshal(data, &creds.fields) != nil || creds.AccessToken == "" || creds.RefreshToken == "" {
		return creds, errCredentials
	}
	data, err = os.ReadFile(filepath.Join(directory, "identity.json"))
	if err != nil {
		return creds, errCredentials
	}
	var identity struct {
		MAC string `json:"mac"`
	}
	if json.Unmarshal(data, &identity) != nil || !macPattern.MatchString(identity.MAC) {
		return creds, errCredentials
	}
	compact := strings.ReplaceAll(identity.MAC, ":", "")
	creds.deviceID = "homelink-" + compact[len(compact)-6:]
	data, err = os.ReadFile(filepath.Join(directory, "sdk_token"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return creds, errCredentials
	}
	creds.sdkToken = strings.TrimSpace(string(data))
	return creds, nil
}

// Saving deliberately has no caller context. A server-issued refresh token must
// reach durable storage before another dispatch can use this pairing directory.
func saveCredentials(directory string, creds credentials) error {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	values := map[string]any{"access_token": creds.AccessToken, "refresh_token": creds.RefreshToken, "token_type": "device", "api_url_v2": creds.APIURL, "noise_host": creds.NoiseHost, "access_token_saved_at": creds.SavedAt}
	for key, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		creds.fields[key] = encoded
	}
	data, err := json.MarshalIndent(creds.fields, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(directory, ".pairing-*.tmp")
	if err != nil {
		return err
	}
	// A successful rename consumes this path; failure cleanup is best effort.
	defer func() { _ = os.Remove(file.Name()) }()
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), filepath.Join(directory, "pairing.json"))
}

type directoryLock struct {
	token chan struct{}
	refs  int
}

var directoryLocks = struct {
	sync.Mutex
	items map[string]*directoryLock
}{items: make(map[string]*directoryLock)}

func lockDirectory(ctx context.Context, path string) (func(), error) {
	canonical, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if real, e := filepath.EvalSymlinks(canonical); e == nil {
		canonical = real
	}
	canonical = filepath.Clean(canonical)
	if runtime.GOOS == "windows" {
		canonical = strings.ToLower(canonical)
	}
	directoryLocks.Lock()
	item := directoryLocks.items[canonical]
	if item == nil {
		item = &directoryLock{token: make(chan struct{}, 1)}
		item.token <- struct{}{}
		directoryLocks.items[canonical] = item
	}
	item.refs++
	directoryLocks.Unlock()
	decrement := func() {
		directoryLocks.Lock()
		defer directoryLocks.Unlock()
		item.refs--
		if item.refs == 0 {
			delete(directoryLocks.items, canonical)
		}
	}
	select {
	case <-ctx.Done():
		decrement()
		return nil, ctx.Err()
	case <-item.token:
		return func() { item.token <- struct{}{}; decrement() }, nil
	}
}

func shouldRefresh(creds credentials) bool {
	return creds.SavedAt > 0 && time.Now().Unix()-creds.SavedAt >= 10800
}
