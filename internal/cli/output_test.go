package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/model"
)

type failedOutput struct{ err error }

func (w failedOutput) Write([]byte) (int, error) { return 0, w.err }

// A broken pipe must fail human status output just as JSON output already does.
// Existing CLI tests collect output in a buffer, which never fails. This uses
// the real command and durable fixture; the writer only models an I/O failure.
func TestStatusReportsHumanOutputFailure(t *testing.T) {
	path, _ := adminFixture(t)
	failure := errors.New("output unavailable")
	err := Run(context.Background(), []string{"--config", path, "status", "--json=false"}, Options{In: strings.NewReader(""), Out: failedOutput{failure}, Err: io.Discard})
	if !errors.Is(err, failure) {
		t.Fatalf("status error = %v, want output failure", err)
	}
}

// An invisible prompt must not consume scripted input or continue setup.
// The production streams already provide the seam; no extra hook is needed.
func TestPromptStopsBeforeReadingWhenOutputFails(t *testing.T) {
	failure := errors.New("prompt unavailable")
	input := strings.NewReader("credential\n")
	c := &command{options: Options{In: input, Err: failedOutput{failure}}, reader: bufio.NewReader(input)}
	if _, err := c.prompt("Credential", "", false); !errors.Is(err, failure) {
		t.Fatalf("prompt error = %v, want output failure", err)
	}
	if input.Len() != len("credential\n") {
		t.Fatal("failed prompt consumed input")
	}
}

// Errors reported after the config commit must leave referenced secrets intact
// when onboarding's deferred rollback runs. Existing conflict coverage only
// checks rollback before a commit. A failing output stream exercises this public
// postcommit error contract without adding a filesystem failure hook.
func TestCommittedConfigSurvivesOutputFailureAndAllowsNextSave(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	if _, err := execute(t, "", "--config", path, "init", "--public-url", "https://relay.example", "--json"); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("output unavailable")
	err := Run(context.Background(), []string{"--config", path, "account", "add", "--id", "tg", "--channel", "telegram", "--allowed-sender", "42"}, Options{In: strings.NewReader("123:committed-token\n"), Out: failedOutput{failure}, Err: io.Discard})
	if !errors.Is(err, failure) {
		t.Fatalf("save output error = %v", err)
	}
	d, err := readDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Accounts) != 1 {
		t.Fatalf("committed account missing: %d", len(d.Accounts))
	}
	var native struct {
		BotToken model.SecretRef `json:"botToken"`
	}
	if err := json.Unmarshal(d.Accounts[0].Config, &native); err != nil {
		t.Fatal(err)
	}
	if value, err := d.ResolveSecret(native.BotToken); err != nil || value != "123:committed-token" {
		t.Fatalf("committed secret removed during rollback: %v", err)
	}
	if _, err := os.Stat(path + ".lock"); !os.IsNotExist(err) {
		t.Fatalf("save lock survived command completion: %v", err)
	}
	if _, err := d.save(); err != nil {
		t.Fatalf("next save blocked: %v", err)
	}
}
