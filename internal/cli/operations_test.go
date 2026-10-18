package cli

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// Scripts need a complete final-reply summary even if the delivery falls outside
// the requested delivery page. Existing CLI tests only cover failed dispatches
// and explicitly request JSON; real stored final replies expose both gaps.
func TestStatusDefaultsToJSONWithDurableReplySummary(t *testing.T) {
	path, _ := adminFixture(t)
	at := enqueueOperatorReply(t, path)
	out, err := execute(t, "", "--config", path, "status", "--include-content", "--delivery-status", "sent")
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		Requests []struct {
			RequestID, AccountID string
			AcceptedAt           int64
			Reply                model.ReplyStatus
		}
		Deliveries []json.RawMessage
	}
	if err = json.Unmarshal([]byte(out), &value); err != nil {
		t.Fatalf("default status is not JSON: %v", err)
	}
	if len(value.Requests) != 1 || len(value.Deliveries) != 0 {
		t.Fatalf("filtered status = %+v", value)
	}
	request := value.Requests[0]
	if request.RequestID != "request-private" || request.AccountID != "bot" || request.AcceptedAt <= 0 || request.Reply.Status != model.Pending || request.Reply.DeliveryID != "operator-final" {
		t.Fatalf("request summary = %+v", request)
	}
	out, err = execute(t, "", "--config", path, "status", "--include-content")
	if err != nil {
		t.Fatal(err)
	}
	var all struct {
		Deliveries []struct {
			DeliveryID, Text string
			DueAt            int64
			ChunkCount       int
			Reply            *model.ReplyReference
		}
	}
	if err = json.Unmarshal([]byte(out), &all); err != nil || len(all.Deliveries) != 1 {
		t.Fatalf("delivery summary = %s %v", out, err)
	}
	delivery := all.Deliveries[0]
	if delivery.DeliveryID != "operator-final" || delivery.DueAt != at.UnixMilli() || delivery.ChunkCount != 2 || delivery.Text != "firstsecond" || delivery.Reply == nil || delivery.Reply.Kind != model.Final {
		t.Fatalf("delivery summary = %+v", delivery)
	}
	assertNoPrivateState(t, out)
}

func enqueueOperatorReply(t *testing.T, path string) time.Time {
	t.Helper()
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.OpenExisting(context.Background(), cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	record, err := store.GetInbound(context.Background(), "request-private")
	if err != nil || record == nil {
		t.Fatalf("request = %v %v", record, err)
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	reply := &model.ReplyReference{RequestID: "request-private", Kind: model.Final}
	receipt, err := store.EnqueueMessage(context.Background(), model.EnqueueMessageInput{
		ChannelID: "conversation", EndpointIDs: []string{"dot"}, Agent: model.Dot,
		Message:  model.OutboundMessage{MessageID: "operator-final", Text: "firstsecond", CreatedAt: at, Reply: reply},
		Outbound: model.OutboundRecord{DeliveryID: "operator-final", ChannelID: "conversation", Endpoint: record.Snapshot.Endpoint, Target: record.Snapshot.Target, MessageID: "operator-final", Reply: reply, Chunks: []model.DeliveryChunk{{Text: "first", IdempotencyKey: "operator-final/0"}, {Text: "second", IdempotencyKey: "operator-final/1"}}, Status: model.DeliveryPending, Version: 1, DueAt: at, CreatedAt: at},
	})
	if err != nil || receipt.Status != model.Queued {
		t.Fatalf("enqueue final = %+v %v", receipt, err)
	}
	return at
}

// Missing references, rather than secret values, are actionable diagnostics.
// The prior boolean-only doctor could not identify which account to repair.
func TestDoctorListsMissingCredentialReferences(t *testing.T) {
	path, _ := adminFixture(t)
	d, err := readDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLI_MISSING_BOT", "")
	d.Accounts = []model.AccountConfig{{ID: "bot", Channel: model.Telegram, AllowedSenders: []string{"22"}, Config: json.RawMessage(`{"botToken":{"env":"CLI_MISSING_BOT"},"webhookSecret":{"file":"missing-webhook.secret"}}`)}}
	if _, err = d.save(); err != nil {
		t.Fatal(err)
	}
	out, err := execute(t, "", "--config", path, "doctor", "--json")
	if err == nil || err.Error() != "doctor_checks_failed" {
		t.Fatalf("doctor error = %v", err)
	}
	var result struct {
		Credentials    bool
		MissingSecrets []string
	}
	if err = json.Unmarshal([]byte(out), &result); err != nil || result.Credentials || !slices.Equal(result.MissingSecrets, []string{"CLI_MISSING_BOT", "missing-webhook.secret"}) {
		t.Fatalf("doctor diagnostics = %s %v", out, err)
	}
}

// A numeric duration is seconds at the public CLI boundary. The normal account
// validation error proves flag parsing accepted it without opening connections.
func TestDiscoveryTimeoutAcceptsSecondsAndDuration(t *testing.T) {
	for _, timeout := range []string{"120", "120s"} {
		_, err := execute(t, "", "--config", filepath.Join(t.TempDir(), "relay.json"), "discover", "--timeout", timeout)
		if err == nil || err.Error() != "account_or_bot_credentials_required" {
			t.Fatalf("timeout %q = %v", timeout, err)
		}
	}
}
