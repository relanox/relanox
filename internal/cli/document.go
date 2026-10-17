package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/app"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

type document struct {
	config.Config
	original []byte
	created  []string
}

func readDocument(path string) (*document, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, problem("config_path_invalid")
	}
	data, err := boundedFile(abs, config.MaxConfigBytes)
	if err != nil {
		return nil, problem("config_unreadable")
	}
	cfg, err := config.Decode(data)
	if err != nil {
		return nil, err
	}
	cfg.Path = abs
	return &document{Config: cfg, original: data}, nil
}

func boundedFile(path string, maximum int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(data)) > maximum {
		return nil, problem("file_unreadable_or_too_large")
	}
	return data, nil
}

func newDocument(path, publicURL string) (*document, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, problem("config_path_invalid")
	}
	cfg, err := config.Decode([]byte(`{"storage":{"driver":"sqlite","path":"state/relanox.db"},"accounts":[],"endpoints":[],"bindings":[]}`))
	if err != nil {
		return nil, err
	}
	cfg.Path = abs
	cfg.HTTP.PublicURL = publicURL
	return &document{Config: cfg}, nil
}

func (d *document) rollback() {
	for _, path := range d.created {
		_ = os.Remove(path)
	}
	d.created = nil
}

// Secrets are immutable files. A successful configuration replacement is the
// commit point; existing credentials are never overwritten or removed.
func (d *document) secret(id, field, value, env string) (model.SecretRef, error) {
	ref := model.SecretRef{Env: env}
	if value == "" {
		if err := config.ValidateSecretRef(ref, "credential"); err != nil {
			return ref, err
		}
		if os.Getenv(env) == "" {
			return ref, problem("credential_value_or_environment_required")
		}
		return ref, nil
	}
	if len(value) > 64<<10 || strings.TrimRight(value, "\r\n") == "" {
		return ref, problem("credential_invalid")
	}
	name := safeName(id) + "-" + safeName(field) + "-" + uuid.NewString() + ".secret"
	rel := filepath.Join("secrets", name)
	path := d.ResolvePath(rel)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return ref, problem("credential_directory_unwritable")
	}
	if err := privatePath(filepath.Dir(path), true); err != nil {
		return ref, problem("credential_directory_permissions_failed")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return ref, problem("credential_file_unwritable")
	}
	d.created = append(d.created, path)
	if err = privatePath(path, false); err != nil {
		_ = file.Close()
		return ref, problem("credential_file_permissions_failed")
	}
	_, err = file.WriteString(value + "\n")
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return ref, problem("credential_file_unwritable")
	}
	ref.File = filepath.ToSlash(rel)
	return ref, nil
}

func safeName(value string) string {
	var result strings.Builder
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			result.WriteRune(r)
		} else {
			result.WriteByte('_')
		}
	}
	return result.String()
}

func (d *document) save() (string, error) {
	if err := app.Validate(d.Config); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(d.Config, "", "  ")
	if err != nil {
		return "", problem("config_encoding_failed")
	}
	data = append(data, '\n')
	if err = os.MkdirAll(filepath.Dir(d.Path), 0700); err != nil {
		return "", problem("config_directory_unwritable")
	}
	lock, err := os.OpenFile(d.Path+".lock", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", problem("config_locked")
	}
	defer os.Remove(d.Path + ".lock")
	_ = lock.Close()
	if err = d.verifyOriginal(); err != nil {
		return "", err
	}
	backup, err := d.backup()
	if err != nil {
		return "", err
	}
	temp, err := os.CreateTemp(filepath.Dir(d.Path), ".relanox-*.json")
	if err != nil {
		return "", problem("config_unwritable")
	}
	defer os.Remove(temp.Name())
	if err = privatePath(temp.Name(), false); err == nil {
		_, err = temp.Write(data)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err != nil || closeErr != nil {
		return "", problem("config_unwritable")
	}
	if err = replaceFile(temp.Name(), d.Path); err != nil {
		return "", problem("config_replace_failed")
	}
	d.original = data
	d.created = nil
	return backup, nil
}

func (d *document) verifyOriginal() error {
	current, err := boundedFile(d.Path, config.MaxConfigBytes)
	if errors.Is(err, os.ErrNotExist) && d.original == nil {
		return nil
	}
	if err != nil || !bytes.Equal(current, d.original) {
		return problem("config_changed_concurrently")
	}
	return nil
}

func (d *document) backup() (string, error) {
	if d.original == nil {
		return "", nil
	}
	path := d.Path + ".backup-" + time.Now().UTC().Format("20060102T150405.000000000") + "-" + uuid.NewString()
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", problem("backup_unwritable")
	}
	if err = privatePath(path, false); err != nil {
		_ = file.Close()
		return "", problem("backup_permissions_failed")
	}
	_, err = file.Write(d.original)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return "", problem("backup_unwritable")
	}
	return path, nil
}
