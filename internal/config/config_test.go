package config_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

const validConfig = `{
 "accounts":[{"id":"a","channel":"matrix","config":{},"allowedSenders":["sender"]}],
 "endpoints":[{"id":"e","agent":"dot","config":{}}],
 "bindings":[{"accountId":"a","chatId":"room","endpointId":"e"}],
 "storage":{"driver":"sqlite","path":"state/relanox.db"}
}`

// These tests protect configuration boundaries: successful decoding alone misses
// cross-account binding errors and credentials leaked in invalid-input errors.
// They exercise only exported production parsing and reference resolution APIs.
func TestDecodeRejectsInvalidRelationsWithoutLeakingInput(t *testing.T) {
	tests := []struct{ name, input, field, code string }{
		{"binding", strings.Replace(validConfig, `"accountId":"a"`, `"accountId":"unconfigured-secret"`, 1), "bindings[0]", "unknown_account_or_endpoint"},
		{"empty_allowlist", strings.Replace(validConfig, `["sender"]`, `[]`, 1), "accounts[0].allowedSenders", "nonempty_allowlist_required"},
		{"unknown_field", strings.Replace(validConfig, `"accounts":`, `"unconfigured-secret":"value","accounts":`, 1), "config", "invalid_json_or_unknown_field"},
		{"legacy_storage", strings.Replace(validConfig, `"driver":"sqlite"`, `"plugin":"sqlite"`, 1), "config", "invalid_json_or_unknown_field"},
		{"short_dispatch_lease", strings.Replace(validConfig, `"storage":`, `"queue":{"leaseSeconds":29},"storage":`, 1), "queue", "invalid_limits"},
		{"startup_timeout", strings.Replace(validConfig, `"storage":`, `"http":{"startupTimeoutSeconds":-1},"storage":`, 1), "http", "invalid_lifecycle_timeout"},
		{"shutdown_timeout", strings.Replace(validConfig, `"storage":`, `"http":{"shutdownTimeoutSeconds":121},"storage":`, 1), "http", "invalid_lifecycle_timeout"},
		{"speech_engine", strings.Replace(validConfig, `"storage":`, `"speech":{"enabled":true,"secretId":{"env":"ASR_ID"},"secretKey":{"env":"ASR_KEY"},"engineModelType":"unconfigured-secret"},"storage":`, 1), "speech.engineModelType", "unsupported_engine"},
		{"speech_region", strings.Replace(validConfig, `"storage":`, `"speech":{"enabled":true,"secretId":{"env":"ASR_ID"},"secretKey":{"env":"ASR_KEY"},"region":"unconfigured-secret/path"},"storage":`, 1), "speech.region", "invalid_region"},
		{"collector_credentials", strings.Replace(validConfig, `"storage":`, `"observability":{"otlpEndpoint":"https://user:unconfigured-secret@example.com/v1/traces"},"storage":`, 1), "observability.otlpEndpoint", "invalid_collector_url"},
		{"collector_query", strings.Replace(validConfig, `"storage":`, `"observability":{"otlpEndpoint":"https://example.com/v1/traces?token=unconfigured-secret"},"storage":`, 1), "observability.otlpEndpoint", "invalid_collector_url"},
		{"collector_empty_port", strings.Replace(validConfig, `"storage":`, `"observability":{"otlpEndpoint":"https://example.com:/v1/traces"},"storage":`, 1), "observability.otlpEndpoint", "invalid_collector_url"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := config.Decode([]byte(tt.input))
			var field *config.FieldError
			if !errors.As(err, &field) || field.Field != tt.field || field.Code != tt.code {
				t.Fatalf("diagnostic = %v", err)
			}
			if strings.Contains(err.Error(), "unconfigured-secret") {
				t.Fatal("diagnostic leaked rejected value")
			}
		})
	}
}

func TestDecodePreservesOpaqueThreadAndRejectsDuplicateConversation(t *testing.T) {
	withThread := strings.Replace(validConfig, `"chatId":"room"`, `"chatId":"room","threadId":"00042"`, 1)
	cfg, err := config.Decode([]byte(withThread))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Bindings[0].ThreadID != "00042" {
		t.Fatalf("thread identity = %q", cfg.Bindings[0].ThreadID)
	}
	cfg.Bindings = append(cfg.Bindings, cfg.Bindings[0])
	var field *config.FieldError
	if err := cfg.Validate(); !errors.As(err, &field) || field.Code != "duplicate_conversation" {
		t.Fatalf("duplicate diagnostic = %v", err)
	}
}

func TestLoadResolvesPathsAndRotatingSecretReferences(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relanox.json")
	if err := os.WriteFile(path, []byte(validConfig), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "credential"), []byte("first\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Storage.Path != filepath.Join(dir, "state", "relanox.db") {
		t.Fatalf("database path = %q", cfg.Storage.Path)
	}
	ref := model.SecretRef{Env: "RELANOX_TEST_CREDENTIAL", File: "credential"}
	t.Setenv("RELANOX_TEST_CREDENTIAL", "override")
	if value, err := cfg.ResolveSecret(ref); err != nil || value != "override" {
		t.Fatalf("environment override: %q %v", value, err)
	}
	t.Setenv("RELANOX_TEST_CREDENTIAL", "")
	if value, err := cfg.ResolveSecret(ref); err != nil || value != "first" {
		t.Fatalf("file fallback: %q %v", value, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "credential"), []byte("rotated"), 0600); err != nil {
		t.Fatal(err)
	}
	if value, err := cfg.ResolveSecret(ref); err != nil || value != "rotated" {
		t.Fatalf("rotated reference: %q %v", value, err)
	}
}

func TestPublicURLRequiresDeploymentOrigin(t *testing.T) {
	for _, value := range []string{"https://example.com/path", "https://user:secret@example.com", "http://example.com", "https://example.com?", "https://example.com#", "https://example.com/../", "https://example.com\\evil", "https://:443", "https://example.com:99999", "https://example.com:0", "https://example.com:"} {
		if _, err := config.ValidatePublicURL(value); err == nil {
			t.Errorf("accepted unsafe origin %q", value)
		}
	}
	for _, value := range []string{"https://example.com", "https://example.com/", "http://127.0.0.1:8080", "http://[::1]:8080"} {
		if _, err := config.ValidatePublicURL(value); err != nil {
			t.Errorf("rejected allowed origin %q: %v", value, err)
		}
	}
}
