package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

func adminFixture(t *testing.T) (string, int64) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "relay.json")
	d, err := newDocument(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.save(); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(cfg.Storage.Path), 0700); err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(ctx, cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	}()
	endpoint := model.EndpointConfig{ID: "dot", Agent: model.Dot, Config: json.RawMessage(`{"mcp":{"token":{"file":"private-credential-location"}}}`)}
	address := model.ChannelAddress{ID: "conversation", Platform: model.Telegram, AccountID: "bot", ChatID: "22"}
	if err = store.RegisterConversations(ctx, []model.ConversationRecord{{Address: address, Endpoint: endpoint}}); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-time.Minute)
	_, err = store.AcceptInbound(ctx, model.InboundSnapshot{RequestID: "request-private", Source: model.SourceKey{Channel: model.Telegram, AccountID: "bot", EventID: "event"}, SenderID: "22", Text: "private message body", Context: json.RawMessage(`{"native":"private-context"}`), Target: model.ReplyTarget{Channel: model.Telegram, AccountID: "bot", ChatID: "22", Data: json.RawMessage(`{"callback":"private-native-target"}`)}, ReceivedAt: at, AcceptedAt: at, Endpoint: endpoint, Channel: address}, nil)
	if err != nil {
		t.Fatal(err)
	}
	work, err := store.TakeDue(ctx, model.TakeDueInput{Now: time.Now(), LeaseOwner: "operator", Limit: 1, LeaseDuration: time.Minute, SendLeaseDuration: time.Minute, PreferredKind: model.DispatchWork})
	if err != nil || len(work) != 1 {
		t.Fatalf("claim=%v %v", work, err)
	}
	_, err = store.SettleAttempt(ctx, model.Settlement{Kind: model.DispatchWork, ID: "request-private", Lease: work[0].Lease, Now: time.Now(), Dispatch: &model.DispatchResult{Status: model.Unknown, ErrorCode: "remote_outcome_unknown"}})
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.GetInbound(ctx, "request-private")
	if err != nil || record == nil {
		t.Fatalf("record=%v %v", record, err)
	}
	return path, record.Version
}

// Protects the operator projection and optimistic replay contract using actual
// durable ambiguous work. Storage tests do not exercise CLI flag mapping or its
// JSON projection, and a mocked store would implement the behavior asserted here.
func TestStatusRedactionAndUnknownRequeueVersionGuard(t *testing.T) {
	path, version := adminFixture(t)
	out, err := execute(t, "", "--config", path, "status", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"status":"unknown"`) {
		t.Fatalf("unknown record missing: %s", out)
	}
	assertNoPrivateState(t, out)
	if strings.Contains(out, "private message body") {
		t.Fatal("status printed text without opt-in")
	}
	content, err := execute(t, "", "--config", path, "status", "--include-content", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, "private message body") {
		t.Fatal("explicit content unavailable")
	}
	assertNoPrivateState(t, content)
	args := []string{"--config", path, "requeue", "--kind", "request", "--id", "request-private", "--expected-version", fmt.Sprint(version), "--json"}
	if _, err = execute(t, "", args...); err == nil {
		t.Fatal("ambiguous dispatch replayed without acknowledgment")
	}
	args = append(args, "--acknowledge-unknown")
	if _, err = execute(t, "", args...); err != nil {
		t.Fatalf("acknowledged replay rejected: %v", err)
	}
	if _, err = execute(t, "", args...); err == nil {
		t.Fatal("stale expected version replayed")
	}
}

func assertNoPrivateState(t *testing.T, out string) {
	t.Helper()
	for _, secret := range []string{"private-native-target", "private-context", "private-credential-location"} {
		if strings.Contains(out, secret) {
			t.Fatalf("operator projection leaked %s", secret)
		}
	}
}

// This guards the CLI-to-OpenExisting wiring, including a zero-byte existing
// file. Storage tests alone cannot catch the CLI accidentally switching to Open.
func TestStatusDoesNotInitializeEmptyDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.json")
	if _, err := execute(t, "", "--config", path, "init", "--json"); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(cfg.Storage.Path), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(cfg.Storage.Path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = execute(t, "", "--config", path, "status", "--json"); err == nil || err.Error() != "database_not_initialized" {
		t.Fatalf("empty database status=%v", err)
	}
	data, err := os.ReadFile(cfg.Storage.Path)
	if err != nil || len(data) != 0 {
		t.Fatal("status initialized the empty database")
	}
}
