package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

// The writer must include its newline in the resolver's 64 KiB file budget.
// Normal onboarding uses short tokens and cannot expose this boundary. These
// real files exercise the production writer and resolver without a test seam.
func TestManagedSecretRespectsFileReadBudget(t *testing.T) {
	d, err := newDocument(filepath.Join(t.TempDir(), "relay.json"), "")
	if err != nil {
		t.Fatal(err)
	}
	defer d.rollback()
	value := strings.Repeat("x", (64<<10)-1)
	ref, err := d.secret("account", "token", value, "")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := d.ResolveSecret(ref); err != nil || got != value {
		t.Fatalf("largest supported managed credential unreadable: %v", err)
	}
	oversized, err := d.secret("account", "token", value+"x", "")
	if err == nil {
		_, loadErr := d.ResolveSecret(oversized)
		t.Fatalf("oversized credential accepted; resolving it returns: %v", loadErr)
	}
	if err.Error() != "credential_invalid" {
		t.Fatalf("oversized managed credential accepted: %v", err)
	}
	files, err := filepath.Glob(filepath.Join(filepath.Dir(d.Path), "secrets", "*.secret"))
	if err != nil || len(files) != 1 {
		t.Fatalf("rejected credential created files: %v %v", files, err)
	}
}

// Editing a compact config can exceed the load limit after indentation. The
// CLI must reject that replacement while retaining the original and removing
// newly generated credentials. Small onboarding/conflict fixtures miss this.
func TestConfigSaveRejectsUnreadableReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	d, err := newDocument(path, "https://relay.example")
	if err != nil {
		t.Fatal(err)
	}
	account := model.AccountConfig{ID: "bot", Channel: model.Telegram,
		Config: json.RawMessage(`{"botToken":{"env":"LARGE_CONFIG_BOT"},"webhookSecret":{"env":"LARGE_CONFIG_WEBHOOK"}}`)}
	for i := range 5500 {
		account.AllowedSenders = append(account.AllowedSenders, fmt.Sprintf("%04d-%s", i, strings.Repeat("x", 749)))
	}
	d.Accounts = []model.AccountConfig{account}
	original, err := json.Marshal(d.Config)
	if err != nil || int64(len(original)) >= config.MaxConfigBytes {
		t.Fatalf("compact fixture exceeds load budget: %d %v", len(original), err)
	}
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Load(path); err != nil {
		t.Fatal(err)
	}
	_, err = execute(t, "", "--config", path, "agent", "add", "--id", "assistant", "--agent", "dot", "--json")
	if err == nil {
		_, loadErr := config.Load(path)
		t.Fatalf("replacement accepted; reloading it returns: %v", loadErr)
	}
	if err.Error() != "config_too_large" {
		t.Fatalf("unreadable replacement accepted: %v", err)
	}
	current, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(current, original) {
		t.Fatalf("original configuration changed: %v", err)
	}
	if _, err := config.Load(path); err != nil {
		t.Fatalf("original configuration unreadable: %v", err)
	}
	files, err := filepath.Glob(filepath.Join(filepath.Dir(path), "secrets", "*.secret"))
	if err != nil || len(files) != 0 {
		t.Fatalf("rejected edit left credentials: %v %v", files, err)
	}
}
