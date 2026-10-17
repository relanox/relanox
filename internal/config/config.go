// Package config loads and validates Go-native Relanox configuration without
// opening platform connections. Native account/endpoint options are decoded by
// their concrete constructors, which must report redacted field diagnostics.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/model"
)

const MaxConfigBytes int64 = 4 << 20

type Storage struct {
	Driver string           `json:"driver"`
	Path   string           `json:"path,omitempty"`
	URL    *model.SecretRef `json:"url,omitempty"`
	Schema string           `json:"schema,omitempty"`
}

type HTTP struct {
	Listen              string `json:"listen"`
	ManagementListen    string `json:"managementListen"`
	PublicURL           string `json:"publicUrl,omitempty"`
	ReadTimeoutSeconds  int    `json:"readTimeoutSeconds,omitempty"`
	WriteTimeoutSeconds int    `json:"writeTimeoutSeconds,omitempty"`
	MaxBodyBytes        int64  `json:"maxBodyBytes,omitempty"`
}

type Queue struct {
	Concurrency      int `json:"concurrency,omitempty"`
	PollIntervalMS   int `json:"pollIntervalMs,omitempty"`
	LeaseSeconds     int `json:"leaseSeconds,omitempty"`
	SendLeaseSeconds int `json:"sendLeaseSeconds,omitempty"`
	MaxAttempts      int `json:"maxAttempts,omitempty"`
	RetentionDays    int `json:"retentionDays,omitempty"`
}

type Observability struct {
	Level        string `json:"level,omitempty"`
	Metrics      bool   `json:"metrics"`
	OTLPEndpoint string `json:"otlpEndpoint,omitempty"`
}

type Speech struct {
	Enabled         bool            `json:"enabled"`
	SecretID        model.SecretRef `json:"secretId"`
	SecretKey       model.SecretRef `json:"secretKey"`
	Region          string          `json:"region,omitempty"`
	EngineModelType string          `json:"engineModelType,omitempty"`
}

type Config struct {
	Accounts      []model.AccountConfig  `json:"accounts"`
	Endpoints     []model.EndpointConfig `json:"endpoints"`
	Bindings      []model.Binding        `json:"bindings"`
	Storage       Storage                `json:"storage"`
	HTTP          HTTP                   `json:"http"`
	Queue         Queue                  `json:"queue"`
	Media         model.MediaLimits      `json:"media"`
	Observability Observability          `json:"observability"`
	Speech        *Speech                `json:"speech,omitempty"`
	// Path is absolute and never serialized into exported configuration.
	Path string `json:"-"`
}

// FieldError exposes only a stable field and error code, never rejected values.
type FieldError struct {
	Field string
	Code  string
}

func (e *FieldError) Error() string { return e.Field + ": " + e.Code }

func invalid(field, code string) error { return &FieldError{Field: field, Code: code} }

// Discover resolves an explicit path, RELANOX_CONFIG, then an existing local
// relanox.json, then the per-user config directory. It never creates files.
func Discover(explicit string) (string, error) {
	if explicit != "" {
		return filepath.Abs(explicit)
	}
	if path := os.Getenv("RELANOX_CONFIG"); path != "" {
		return filepath.Abs(path)
	}
	if _, err := os.Stat("relanox.json"); err == nil {
		return filepath.Abs("relanox.json")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", invalid("config", "unreadable")
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", invalid("config", "config_directory_unavailable")
	}
	return filepath.Join(dir, "relanox", "relanox.json"), nil
}

func Load(path string) (Config, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Config{}, invalid("config", "invalid_path")
	}
	file, err := os.Open(abs)
	if err != nil {
		return Config{}, invalid("config", "unreadable")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, MaxConfigBytes+1))
	if err != nil {
		return Config{}, invalid("config", "unreadable")
	}
	if int64(len(data)) > MaxConfigBytes {
		return Config{}, invalid("config", "too_large")
	}
	cfg, err := Decode(data)
	if err != nil {
		return Config{}, err
	}
	cfg.Path = abs
	if cfg.Storage.Path != "" {
		cfg.Storage.Path = cfg.ResolvePath(cfg.Storage.Path)
	}
	return cfg, nil
}

func Decode(data []byte) (Config, error) {
	var cfg Config
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return Config{}, decodeError(err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Config{}, invalid("config", "trailing_json")
	}
	cfg.defaults()
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func decodeError(err error) error {
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) && typeErr.Field != "" {
		return invalid(typeErr.Field, "invalid_type")
	}
	// Do not return decoder errors: unknown field names can contain secrets.
	return invalid("config", "invalid_json_or_unknown_field")
}

func (c *Config) defaults() {
	if c.HTTP.Listen == "" {
		c.HTTP.Listen = "127.0.0.1:8787"
	}
	if c.HTTP.ManagementListen == "" {
		c.HTTP.ManagementListen = "127.0.0.1:8788"
	}
	if c.HTTP.ReadTimeoutSeconds == 0 {
		c.HTTP.ReadTimeoutSeconds = 30
	}
	if c.HTTP.WriteTimeoutSeconds == 0 {
		c.HTTP.WriteTimeoutSeconds = 60
	}
	if c.HTTP.MaxBodyBytes == 0 {
		c.HTTP.MaxBodyBytes = 4 << 20
	}
	if c.Queue.Concurrency == 0 {
		c.Queue.Concurrency = 4
	}
	if c.Queue.PollIntervalMS == 0 {
		c.Queue.PollIntervalMS = 500
	}
	if c.Queue.LeaseSeconds == 0 {
		c.Queue.LeaseSeconds = 60
	}
	if c.Queue.SendLeaseSeconds == 0 {
		c.Queue.SendLeaseSeconds = 180
	}
	if c.Queue.MaxAttempts == 0 {
		c.Queue.MaxAttempts = 8
	}
	if c.Queue.RetentionDays == 0 {
		c.Queue.RetentionDays = 30
	}
	if c.Media.MaxBytes == 0 {
		c.Media.MaxBytes = 100 << 20
	}
	if c.Media.MaxTotalBytes == 0 {
		c.Media.MaxTotalBytes = 100 << 20
	}
	if c.Media.MaxAttachments == 0 {
		c.Media.MaxAttachments = 10
	}
	if c.Observability.Level == "" {
		c.Observability.Level = "info"
	}
}

var localID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func (c Config) Validate() error {
	accounts, endpoints, err := validateIdentities(c)
	if err != nil {
		return err
	}
	if err := validateBindings(c.Bindings, accounts, endpoints); err != nil {
		return err
	}
	if err := validateStorage(c.Storage); err != nil {
		return err
	}
	if c.HTTP.PublicURL != "" {
		if _, err := ValidatePublicURL(c.HTTP.PublicURL); err != nil {
			return err
		}
	}
	if err := c.validateRuntimeLimits(); err != nil {
		return err
	}
	return c.validateObservabilityAndSpeech()
}

func (c Config) validateRuntimeLimits() error {
	if c.HTTP.ReadTimeoutSeconds < 1 || c.HTTP.WriteTimeoutSeconds < 1 || c.HTTP.MaxBodyBytes < 1 {
		return invalid("http", "invalid_limits")
	}
	if c.Queue.Concurrency < 1 || c.Queue.Concurrency > 1024 || c.Queue.PollIntervalMS < 1 || c.Queue.LeaseSeconds < 30 || c.Queue.SendLeaseSeconds < 1 || c.Queue.MaxAttempts < 1 || c.Queue.RetentionDays < 1 {
		return invalid("queue", "invalid_limits")
	}
	if c.Media.MaxBytes < 1 || c.Media.MaxTotalBytes < c.Media.MaxBytes || c.Media.MaxAttachments < 1 {
		return invalid("media", "invalid_limits")
	}
	return nil
}

func (c Config) validateObservabilityAndSpeech() error {
	switch c.Observability.Level {
	case "debug", "info", "warn", "error":
	default:
		return invalid("observability.level", "invalid_level")
	}
	if c.Speech != nil {
		return ValidateSpeech(*c.Speech)
	}
	return nil
}

func validateIdentities(c Config) (map[string]bool, map[string]bool, error) {
	accounts, endpoints := make(map[string]bool), make(map[string]bool)
	for i, account := range c.Accounts {
		field := fmt.Sprintf("accounts[%d]", i)
		if !localID.MatchString(account.ID) || !account.Channel.Valid() {
			return nil, nil, invalid(field, "invalid_identity")
		}
		if accounts[account.ID] {
			return nil, nil, invalid(field+".id", "duplicate")
		}
		if !validSenders(account.AllowedSenders) {
			return nil, nil, invalid(field+".allowedSenders", "nonempty_allowlist_required")
		}
		if !json.Valid(account.Config) {
			return nil, nil, invalid(field+".config", "invalid_json")
		}
		accounts[account.ID] = true
	}
	for i, endpoint := range c.Endpoints {
		field := fmt.Sprintf("endpoints[%d]", i)
		if !localID.MatchString(endpoint.ID) || !endpoint.Agent.Valid() {
			return nil, nil, invalid(field, "invalid_identity")
		}
		if endpoints[endpoint.ID] {
			return nil, nil, invalid(field+".id", "duplicate")
		}
		if !json.Valid(endpoint.Config) {
			return nil, nil, invalid(field+".config", "invalid_json")
		}
		endpoints[endpoint.ID] = true
	}
	return accounts, endpoints, nil
}

func validateBindings(bindings []model.Binding, accounts, endpoints map[string]bool) error {
	seen := make(map[[3]string]bool)
	for i, binding := range bindings {
		field := fmt.Sprintf("bindings[%d]", i)
		if !accounts[binding.AccountID] || !endpoints[binding.EndpointID] {
			return invalid(field, "unknown_account_or_endpoint")
		}
		if !validPlatformID(binding.ChatID) || len(binding.ThreadID) > 1024 {
			return invalid(field, "invalid_native_address")
		}
		if binding.AllowedSenders != nil && !validSenders(binding.AllowedSenders) {
			return invalid(field+".allowedSenders", "nonempty_allowlist_required")
		}
		key := [3]string{binding.AccountID, binding.ChatID, binding.ThreadID}
		if seen[key] {
			return invalid(field, "duplicate_conversation")
		}
		seen[key] = true
	}
	return nil
}

func validPlatformID(value string) bool {
	return len(value) > 0 && len(value) <= 1024 && !strings.ContainsRune(value, 0)
}

func validSenders(senders []string) bool {
	if len(senders) == 0 {
		return false
	}
	for _, sender := range senders {
		if !validPlatformID(sender) {
			return false
		}
	}
	return true
}

func validateStorage(storage Storage) error {
	switch storage.Driver {
	case "sqlite":
		if storage.Path == "" || storage.URL != nil || storage.Schema != "" {
			return invalid("storage", "sqlite_path_required")
		}
	case "postgres":
		if storage.URL == nil || storage.Path != "" {
			return invalid("storage", "postgres_url_reference_required")
		}
		if err := ValidateSecretRef(*storage.URL, "storage.url"); err != nil {
			return err
		}
		if storage.Schema != "" && !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,62}$`).MatchString(storage.Schema) {
			return invalid("storage.schema", "invalid_identifier")
		}
	default:
		return invalid("storage.driver", "unsupported_driver")
	}
	return nil
}

func (c Config) ResolvePath(path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(filepath.Dir(c.Path), path)
}

func (q Queue) PollInterval() time.Duration {
	return time.Duration(q.PollIntervalMS) * time.Millisecond
}

func (q Queue) LeaseDuration() time.Duration { return time.Duration(q.LeaseSeconds) * time.Second }
