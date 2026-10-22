package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/channels/wechat"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

func execute(t *testing.T, input string, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := Run(context.Background(), args, Options{In: strings.NewReader(input), Out: &out, Err: io.Discard})
	return out.String(), err
}

// Hyphens are valid local IDs, but previously produced invalid secret env names.
// Existing onboarding only used bare-word IDs. Exercise the real commands and
// resolve saved references, without adding a production-only test seam.
func TestOnboardingHyphenatedIDsKeepUsableCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	if _, err := execute(t, "", "--config", path, "init", "--public-url", "https://relay.example"); err != nil {
		t.Fatal(err)
	}
	if _, err := execute(t, "123:managed-token\n", "--config", path, "account", "add", "--id", "my-bot", "--channel", "telegram", "--allowed-sender", "42"); err != nil {
		t.Fatal(err)
	}
	if _, err := execute(t, "", "--config", path, "agent", "add", "--id", "my-agent", "--agent", "dot", "--json"); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	var account struct {
		BotToken model.SecretRef `json:"botToken"`
	}
	if err := json.Unmarshal(cfg.Accounts[0].Config, &account); err != nil {
		t.Fatal(err)
	}
	if account.BotToken.Env != "RELANOX_MY_BOT_BOTTOKEN" {
		t.Fatalf("invalid environment override: %q", account.BotToken.Env)
	}
	if value, err := cfg.ResolveSecret(account.BotToken); err != nil || value != "123:managed-token" {
		t.Fatalf("managed credential unavailable: %v", err)
	}
	t.Setenv("RELANOX_MY_BOT_BOTTOKEN", "456:rotated-token")
	if value, err := cfg.ResolveSecret(account.BotToken); err != nil || value != "456:rotated-token" {
		t.Fatalf("environment override unavailable: %v", err)
	}
	if _, err := execute(t, "", "--config", path, "validate"); err != nil {
		t.Fatal(err)
	}
}

// Setup should bind the account and endpoint it just collected, even when an
// older endpoint exists. Separate add/bind tests miss the wizard's repeated ID
// prompts. This uses the real input stream, config writer and offline validator.
func TestSetupBindsNewAccountAndEndpointWithoutRepeatingIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	if _, err := execute(t, "", "--config", path, "init", "--public-url", "https://relay.example"); err != nil {
		t.Fatal(err)
	}
	if _, err := execute(t, "", "--config", path, "agent", "add", "--id", "existing", "--agent", "dot", "--json"); err != nil {
		t.Fatal(err)
	}
	input := "tg\ntelegram\n42\n123:new-token\nassistant\ndot\n42\n"
	if _, err := execute(t, input, "--config", path, "setup"); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Bindings) != 1 || cfg.Bindings[0].AccountID != "tg" || cfg.Bindings[0].EndpointID != "assistant" || cfg.Bindings[0].ChatID != "42" {
		t.Fatalf("wizard bound wrong conversation: %+v", cfg.Bindings)
	}
	if len(cfg.Endpoints) != 2 || cfg.Endpoints[0].ID != "existing" {
		t.Fatal("existing endpoint was changed")
	}
	if _, err := execute(t, "", "--config", path, "validate"); err != nil {
		t.Fatal(err)
	}
}

// Protects the executable onboarding contract: portable paths, durable managed
// credentials, native callback/MCP instructions and offline validation. Native
// constructors do not exercise file editing or scripted operator commands.
func TestOnboardingPersistsPortableConfigAndConnectionInstructions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	if _, err := execute(t, "", "--config", path, "init", "--public-url", "https://relay.example", "--json"); err != nil {
		t.Fatal(err)
	}
	input := "123:real-token\n"
	if _, err := execute(t, input, "--config", path, "account", "add", "--id", "tg", "--channel", "telegram", "--allowed-sender", "42"); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(filepath.Dir(path), "paired")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	out, err := execute(t, "", "--config", path, "agent", "add", "--id", "muse", "--agent", "muse", "--credentials-directory", "paired", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "https://relay.example/agents/muse/mcp/muse") || !strings.Contains(out, "/channels/telegram/tg/webhook") {
		t.Fatalf("connection instructions absent: %s", out)
	}
	if _, err = execute(t, "", "--config", path, "bind", "--account", "tg", "--chat", "42", "--endpoint", "muse", "--json"); err != nil {
		t.Fatal(err)
	}
	if _, err = execute(t, "", "--config", path, "validate", "--json"); err != nil {
		t.Fatal(err)
	}
	assertPortableCredentials(t, path)
	backups, err := filepath.Glob(path + ".backup-*")
	if err != nil || len(backups) != 3 {
		t.Fatalf("backups=%v %v", backups, err)
	}
	if strings.Contains(out, "real-token") {
		t.Fatal("credential printed")
	}
	if _, err = os.Stat(filepath.Join(filepath.Dir(path), "state", "relanox.db")); !os.IsNotExist(err) {
		t.Fatal("offline onboarding or validate opened storage")
	}
}

// Concurrent config changes must not be clobbered, and credentials created for
// a rejected save must not survive. This needs no test-only production seam.
func TestConfigConflictPreservesOriginalAndRollsBackOnlyNewSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	if _, err := execute(t, "", "--config", path, "init", "--json"); err != nil {
		t.Fatal(err)
	}
	d, err := readDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	ref, err := d.secret("account", "token", "new-secret", "")
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	changed := append([]byte("\n"), original...)
	if err = os.WriteFile(path, changed, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = d.save(); err == nil || err.Error() != "config_changed_concurrently" {
		t.Fatalf("conflict=%v", err)
	}
	d.rollback()
	if _, err = os.Stat(d.ResolvePath(ref.File)); !os.IsNotExist(err) {
		t.Fatal("uncommitted credential survived rollback")
	}
	current, _ := os.ReadFile(path)
	if !bytes.Equal(current, changed) {
		t.Fatal("concurrent configuration was overwritten")
	}
}

// Source protocol: Tencent native QR login fields, not a local fake auth flow.
// https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts
// A refresh must save the actual token and preserve existing bindings/allowlist.
func TestWechatLoginSavesActualCredentialsAndRefreshKeepsOldFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	token := "native-token-1"
	var peer *httptest.Server
	peer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ilink/bot/get_bot_qrcode":
			_, _ = io.WriteString(w, `{"qrcode":"native-code","qrcode_img_content":"https://weixin.qq.com/qrcode/native"}`)
		case "/ilink/bot/get_qrcode_status":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "confirmed", "bot_token": token, "ilink_bot_id": "bot-native", "ilink_user_id": "sender-native", "baseurl": peer.URL})
		default:
			t.Errorf("unexpected pairing route %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer peer.Close()
	args := []string{"--config", path, "wechat-login", "--account", "wx", "--api-base", peer.URL, "--allow-insecure-loopback", "--json"}
	out, err := execute(t, "", args...)
	if err != nil {
		t.Fatal(err)
	}
	first, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	var native wechat.Config
	_ = json.Unmarshal(first.Accounts[0].Config, &native)
	oldPath := first.ResolvePath(native.BotToken.File)
	if value, err := first.ResolveSecret(native.BotToken); err != nil || value != token {
		t.Fatal("actual native token not saved")
	}
	if first.Accounts[0].AllowedSenders[0] != "sender-native" || native.BotID != "bot-native" || native.APIBaseURL != peer.URL {
		t.Fatal("confirmed native identity lost")
	}
	d, err := readDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	d.Accounts[0].AllowedSenders = append(d.Accounts[0].AllowedSenders, "previous-sender")
	if _, err = d.save(); err != nil {
		t.Fatal(err)
	}
	token = "native-token-2"
	more, err := execute(t, "", args...)
	if err != nil {
		t.Fatal(err)
	}
	second, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(second.Accounts[0].Config, &native)
	if value, err := second.ResolveSecret(native.BotToken); err != nil || value != token {
		t.Fatal("refreshed actual token not saved")
	}
	old, _ := os.ReadFile(oldPath)
	if string(old) != "native-token-1\n" || len(second.Accounts[0].AllowedSenders) != 2 {
		t.Fatal("refresh removed prior recoverable credentials or allowlist")
	}
	if strings.Contains(out+more, "native-token-") {
		t.Fatal("pairing leaked token")
	}
}

func TestInvalidCommandAndArgumentsAreSafeStableCodes(t *testing.T) {
	for _, row := range []struct {
		args []string
		want string
	}{{[]string{"secret-not-a-command"}, "invalid_command"}, {[]string{"validate", "--token=secret"}, "invalid_arguments"}, {[]string{"validate", "unexpected-secret"}, "invalid_arguments"}} {
		_, err := execute(t, "", row.args...)
		if err == nil || err.Error() != row.want {
			t.Fatalf("safe diagnostic=%v want %s", err, row.want)
		}
	}
}

func assertPortableCredentials(t *testing.T, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("123:real-token")) {
		t.Fatal("raw credential persisted in JSON")
	}
	d, err := readDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	if d.Storage.Path != "state/relanox.db" {
		t.Fatalf("portable storage path changed: %s", d.Storage.Path)
	}
	var native struct {
		BotToken      model.SecretRef `json:"botToken"`
		WebhookSecret model.SecretRef `json:"webhookSecret"`
	}
	_ = json.Unmarshal(d.Accounts[0].Config, &native)
	if value, err := d.ResolveSecret(native.BotToken); err != nil || value != "123:real-token" {
		t.Fatalf("managed secret unavailable: %v", err)
	}
	if value, err := d.ResolveSecret(native.WebhookSecret); err != nil || len(value) < 32 {
		t.Fatalf("webhook secret missing: %v", err)
	}
	t.Setenv(native.BotToken.Env, "456:rotated")
	if value, err := d.ResolveSecret(native.BotToken); err != nil || value != "456:rotated" {
		t.Fatal("environment override did not take precedence")
	}
}
