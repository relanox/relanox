// Device API contracts are based on the official Muse gadget SDK:
// https://github.com/facebookincubator/muse-gadget-sdk/blob/fa073045a5572a8e3367fae142c1b7a7c554f222/linux/src/musegadget/muse_api.py
package musewire

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type vm struct {
	ID      string `json:"vm_id"`
	Name    string `json:"vm_name"`
	URL     string `json:"vm_url"`
	WSURL   string `json:"vm_ws_url"`
	Token   string `json:"vm_auth_token"`
	Default bool   `json:"default"`
}

type httpError struct{ status int }

func (e httpError) Error() string { return "muse: API request rejected" }

func apiCall(ctx context.Context, client *http.Client, creds credentials, path, token string, body any, out any) error {
	root, err := url.Parse(creds.APIURL)
	if creds.APIURL == "" {
		root, err = url.Parse("https://api.muse.ai")
	}
	if err != nil || root.Scheme != "https" || root.User != nil || root.Host == "" || root.RawQuery != "" || root.Fragment != "" {
		return errCredentials
	}
	var data []byte
	method := http.MethodGet
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
		method = http.MethodPost
	}
	bounded, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	// Official api_root() preserves api_url_v2's prefix, unlike the old TS SDK.
	root.Path = strings.TrimRight(root.Path, "/") + path
	root.RawPath = ""
	req, err := http.NewRequestWithContext(bounded, method, root.String(), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-API-Version", "1.0.0")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "relanox-muse/0.1.0")
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("muse: API unavailable")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return httpError{resp.StatusCode}
	}
	encoded, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20+1))
	if err != nil {
		return err
	}
	if len(encoded) > 1<<20 {
		return errProtocol
	}
	if json.Unmarshal(encoded, out) != nil {
		return errProtocol
	}
	return nil
}

func refresh(ctx context.Context, client *http.Client, directory string, creds *credentials) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	parts := strings.Split(creds.RefreshToken, ":")
	raw := parts[len(parts)-1]
	if raw == "" {
		return errCredentials
	}
	body := map[string]string{"device_id": creds.deviceID}
	if creds.sdkToken != "" {
		body["sdk_token"] = creds.sdkToken
	}
	var result struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		Payload *struct {
			Access  string `json:"access_token"`
			Refresh string `json:"refresh_token"`
		} `json:"payload"`
	}
	// Rotation consumes its predecessor. Complete this bounded exchange and save
	// the successor even when the requesting dispatch is cancelled meanwhile.
	if err := apiCall(context.WithoutCancel(ctx), client, *creds, "/device_token/refresh", "hatch_refresh:"+raw, body, &result); err != nil {
		return err
	}
	if result.Payload != nil {
		result.Access = result.Payload.Access
		result.Refresh = result.Payload.Refresh
	}
	if result.Access == "" || result.Refresh == "" {
		return errProtocol
	}
	creds.AccessToken, creds.RefreshToken = result.Access, result.Refresh
	creds.SavedAt = time.Now().Unix()
	return saveCredentials(directory, *creds)
}

func listVMs(ctx context.Context, client *http.Client, directory string, creds *credentials) ([]vm, error) {
	if shouldRefresh(*creds) {
		if err := refresh(ctx, client, directory, creds); err != nil {
			return nil, err
		}
	}
	var result struct {
		VMs *[]vm `json:"vm_list"`
	}
	err := apiCall(ctx, client, *creds, "/fetch_vms", creds.AccessToken, nil, &result)
	var receipt httpError
	if errors.As(err, &receipt) && receipt.status == 401 {
		if err = refresh(ctx, client, directory, creds); err != nil {
			return nil, err
		}
		err = apiCall(ctx, client, *creds, "/fetch_vms", creds.AccessToken, nil, &result)
	}
	if err != nil {
		return nil, err
	}
	if result.VMs == nil {
		return nil, errProtocol
	}
	for _, vm := range *result.VMs {
		if vm.ID == "" || vm.Token == "" || (vm.URL == "" && vm.WSURL == "") {
			return nil, errProtocol
		}
	}
	return *result.VMs, nil
}
