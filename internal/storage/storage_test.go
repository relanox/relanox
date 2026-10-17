package storage_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ariga.io/atlas/sql/postgres"
	atlasschema "ariga.io/atlas/sql/schema"
	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// Real database tests protect durable acceptance/reopen, competing writers,
// final-reply uniqueness, lease ambiguity/fencing and CAS ABA. Credible failures
// are check-then-insert races, blind retries and physical state deletion. The Go
// runtime had no storage coverage; these use the same Open API as production.
var ctx = context.Background()

var postgresSchemas sync.Map

func openStore(t *testing.T, path string) *storage.Store {
	t.Helper()
	cfg := config.Storage{Driver: "sqlite", Path: path}
	var resolve func(model.SecretRef) (string, error)
	if dsn := os.Getenv("RELANOX_TEST_POSTGRES_URL"); dsn != "" {
		name, ok := postgresSchemas.Load(path)
		if !ok {
			name = createPostgresSchema(t, dsn)
			postgresSchemas.Store(path, name)
		}
		cfg = config.Storage{Driver: "postgres", Schema: name.(string), URL: &model.SecretRef{Env: "RELANOX_TEST_POSTGRES_URL"}}
		resolve = func(model.SecretRef) (string, error) { return dsn, nil }
		t.Log("using real PostgreSQL")
	}
	s, err := storage.Open(ctx, cfg, resolve)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func createPostgresSchema(t *testing.T, dsn string) string {
	t.Helper()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	driver, err := postgres.Open(db)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	name := "relanox_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	schema := &atlasschema.Schema{Name: name}
	if err := driver.ApplyChanges(ctx, []atlasschema.Change{&atlasschema.AddSchema{S: schema}}); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := driver.ApplyChanges(ctx, []atlasschema.Change{&atlasschema.DropSchema{S: schema}}); err != nil {
			t.Error(err)
		}
		_ = db.Close()
	})
	return name
}

func conversationRecord() model.ConversationRecord {
	return model.ConversationRecord{Address: model.ChannelAddress{ID: "c1", Platform: model.Telegram, AccountID: "account", ChatID: "chat"}, Endpoint: model.EndpointConfig{ID: "agent", Agent: model.Dot, Config: json.RawMessage(`{"url":"https://example.com"}`)}}
}

func snapshot(id string, at time.Time) model.InboundSnapshot {
	c := conversationRecord()
	return model.InboundSnapshot{Source: model.SourceKey{Channel: model.Telegram, AccountID: "account", EventID: "event-" + id}, SenderID: "sender", Text: "original " + id, Target: model.ReplyTarget{Channel: model.Telegram, AccountID: "account", ChatID: "chat", ReplyToID: "native-id"}, ReceivedAt: at, Channel: c.Address, Endpoint: c.Endpoint, RequestID: id, AcceptedAt: at}
}

func initialize(t *testing.T, s *storage.Store) {
	t.Helper()
	if err := s.RegisterConversations(ctx, []model.ConversationRecord{conversationRecord()}); err != nil {
		t.Fatal(err)
	}
}

func TestAcceptanceDeduplicatesAndSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "durable.db")
	s := openStore(t, path)
	initialize(t, s)
	at := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	input := snapshot("one", at)
	r, err := s.AcceptInbound(ctx, input, nil)
	if err != nil || r.RequestID != "one" || r.Duplicate {
		t.Fatalf("accept: %#v %v", r, err)
	}
	input.RequestID = "replacement"
	input.Text = "must not replace"
	r, err = s.AcceptInbound(ctx, input, nil)
	if err != nil || r.RequestID != "one" || !r.Duplicate {
		t.Fatalf("dedup: %#v %v", r, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := openStore(t, path)
	stored, err := reopened.GetInbound(ctx, "one")
	if err != nil || stored == nil || stored.Snapshot.Text != "original one" || stored.Version != 1 {
		t.Fatalf("reopen: %#v %v", stored, err)
	}
	c, err := reopened.GetConversation(ctx, "c1", false)
	if err != nil || c.Target == nil || c.Target.ReplyToID != "native-id" {
		t.Fatalf("learned target: %#v %v", c, err)
	}
}

func TestStateTombstonesFenceABAAndConcurrentWriters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	stores := []*storage.Store{openStore(t, path), openStore(t, path)}
	ns := model.StateNamespace{Component: "channel", OwnerID: "account"}
	expires := time.Now().Add(-time.Hour)
	r, err := stores[0].CompareAndSetState(ctx, ns, model.CompareAndSetStateInput{Key: "token", Value: json.RawMessage(`{"generation":1}`), ExpiresAt: &expires})
	if err != nil || r.Status != model.Updated || r.Version != 1 {
		t.Fatalf("initial state: %#v %v", r, err)
	}
	r, err = stores[1].CompareAndSetState(ctx, ns, model.CompareAndSetStateInput{Key: "token", Value: json.RawMessage(`2`)})
	if err != nil || r.Status != model.Conflict {
		t.Fatalf("expired entry must not disappear: %#v %v", r, err)
	}
	r, err = stores[0].DeleteState(ctx, ns, "token", 1)
	if err != nil || r.Version != 2 {
		t.Fatalf("delete: %#v %v", r, err)
	}
	r, err = stores[1].CompareAndSetState(ctx, ns, model.CompareAndSetStateInput{Key: "token", Value: json.RawMessage(`3`)})
	if err != nil || r.Status != model.Updated || r.Version != 3 {
		t.Fatalf("ABA generation: %#v %v", r, err)
	}
	version := int64(1)
	r, err = stores[0].CompareAndSetState(ctx, ns, model.CompareAndSetStateInput{Key: "token", ExpectedVersion: &version, Value: json.RawMessage(`4`)})
	if err != nil || r.Status != model.Conflict {
		t.Fatalf("stale state write: %#v %v", r, err)
	}
	version = 3
	var wait sync.WaitGroup
	results := make(chan model.MutationResult, 16)
	for i := range 16 {
		wait.Go(func() {
			r, err := stores[i%2].CompareAndSetState(ctx, ns, model.CompareAndSetStateInput{Key: "token", ExpectedVersion: &version, Value: json.RawMessage(`4`)})
			if err != nil {
				t.Error(err)
			}
			results <- r
		})
	}
	wait.Wait()
	close(results)
	winners := 0
	for r := range results {
		if r.Status == model.Updated {
			winners++
			if r.Version != 4 {
				t.Fatalf("version: %#v", r)
			}
		}
	}
	if winners != 1 {
		t.Fatalf("CAS winners=%d", winners)
	}
}

func outboundInput(key, delivery string, at time.Time, reply *model.ReplyReference) model.EnqueueMessageInput {
	c := conversationRecord()
	target := model.ReplyTarget{Channel: model.Telegram, AccountID: "account", ChatID: "chat"}
	return model.EnqueueMessageInput{ChannelID: "c1", EndpointIDs: []string{"agent"}, Agent: model.Dot, Message: model.OutboundMessage{MessageID: key, Text: "answer", CreatedAt: at, Reply: reply}, Outbound: model.OutboundRecord{DeliveryID: delivery, ChannelID: "c1", Endpoint: c.Endpoint, MessageID: key, Target: target, Reply: reply, Chunks: []model.DeliveryChunk{{Text: "first", IdempotencyKey: delivery + "/0"}, {Text: "second", IdempotencyKey: delivery + "/1"}}, Status: model.DeliveryPending, Version: 1, DueAt: at, CreatedAt: at}, Limits: model.MediaLimits{MaxBytes: 100, MaxTotalBytes: 200, MaxAttachments: 20}}
}

func take(t *testing.T, s *storage.Store, at time.Time, kind model.WorkKind) []model.DueWork {
	t.Helper()
	work, err := s.TakeDue(ctx, model.TakeDueInput{Now: at, LeaseDuration: time.Minute, LeaseOwner: "test", Limit: 1, PreferredKind: kind})
	if err != nil {
		t.Fatal(err)
	}
	return work
}

func settle(t *testing.T, s *storage.Store, work model.DueWork, at time.Time, status model.Outcome) model.MutationResult {
	t.Helper()
	input := model.Settlement{Kind: work.Kind, Lease: work.Lease, Now: at, NextDueAt: at}
	if work.Kind == model.SendWork {
		input.ID = work.Outbound.DeliveryID
		input.Send = &model.SendResult{Status: status, Receipt: &model.SendReceipt{PlatformMessageID: "confirmed"}}
	} else {
		input.ID = work.Inbound.Snapshot.RequestID
		input.Dispatch = &model.DispatchResult{Status: status}
	}
	r, err := s.SettleAttempt(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestFinalReplyIsUniqueAndCompletesOnlyAfterAllChunks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "final.db")
	stores := []*storage.Store{openStore(t, path), openStore(t, path)}
	initialize(t, stores[0])
	at := time.Now().UTC()
	if _, err := stores[0].AcceptInbound(ctx, snapshot("request", at), nil); err != nil {
		t.Fatal(err)
	}
	work := take(t, stores[0], at, model.DispatchWork)
	if len(work) != 1 || settle(t, stores[0], work[0], at, model.Accepted).Status != model.Updated {
		t.Fatal("dispatch was not accepted")
	}
	var wait sync.WaitGroup
	results := make(chan model.MessageReceipt, 2)
	inputs := []model.EnqueueMessageInput{outboundInput("key-one", "delivery-one", at, &model.ReplyReference{RequestID: "request", Kind: model.Final}), outboundInput("key-two", "delivery-two", at, &model.ReplyReference{RequestID: "request", Kind: model.Final})}
	for i := range 2 {
		wait.Go(func() {
			r, err := stores[i].EnqueueMessage(ctx, inputs[i])
			if err != nil {
				t.Error(err)
			}
			results <- r
		})
	}
	wait.Wait()
	close(results)
	winner := ""
	queued, conflicts := 0, 0
	for r := range results {
		if r.Status == model.Queued {
			queued++
			winner = r.DeliveryID
		}
		if r.Status == model.Conflict {
			conflicts++
		}
	}
	if queued != 1 || conflicts != 1 {
		t.Fatalf("final race: queued=%d conflicts=%d", queued, conflicts)
	}
	pending, err := stores[0].ListPendingInbound(ctx, model.ListPendingInboundInput{ChannelIDs: []string{"c1"}, EndpointIDs: []string{"agent"}, Limit: 20})
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending final: %v %#v", err, pending)
	}
	for chunk := range 2 {
		work = take(t, stores[1], at, model.SendWork)
		if len(work) != 1 || work[0].Outbound.DeliveryID != winner || work[0].Outbound.CurrentChunk != chunk {
			t.Fatalf("chunk %d: %#v", chunk, work)
		}
		if r := settle(t, stores[1], work[0], at, model.Sent); r.Status != model.Updated {
			t.Fatalf("settle: %#v", r)
		}
		pending, err = stores[0].ListPendingInbound(ctx, model.ListPendingInboundInput{ChannelIDs: []string{"c1"}, EndpointIDs: []string{"agent"}, Limit: 20})
		if err != nil || len(pending) != 1-chunk {
			t.Fatalf("completion after chunk %d: %#v %v", chunk, pending, err)
		}
	}
	if _, err := stores[0].Cleanup(ctx, model.CleanupInput{Before: at.Add(time.Hour), Limit: 20}); err != nil {
		t.Fatal(err)
	}
	for _, input := range inputs {
		if input.Outbound.DeliveryID == winner {
			input.Message.CreatedAt = at.Add(2 * time.Hour)
			r, err := stores[0].GetMessageReceipt(ctx, model.MessageReceiptInput{ChannelID: "c1", EndpointIDs: []string{"agent"}, Agent: model.Dot, Message: input.Message})
			if err != nil || r.Status != model.Queued || !r.Replay || r.DeliveryID != winner {
				t.Fatalf("retained replay: %#v %v", r, err)
			}
		}
	}
}

func TestExpiredAmbiguousSendBlocksFIFOAndFencesLateSettlement(t *testing.T) {
	s := openStore(t, filepath.Join(t.TempDir(), "leases.db"))
	initialize(t, s)
	at := time.Now().UTC()
	for _, input := range []model.EnqueueMessageInput{outboundInput("one", "one", at, nil), outboundInput("two", "two", at.Add(time.Millisecond), nil)} {
		r, err := s.EnqueueMessage(ctx, input)
		if err != nil || r.Status != model.Queued {
			t.Fatalf("enqueue: %#v %v", r, err)
		}
	}
	first := take(t, s, at, model.SendWork)
	if len(first) != 1 || first[0].Outbound.DeliveryID != "one" {
		t.Fatalf("first: %#v", first)
	}
	if work := take(t, s, at.Add(2*time.Minute), model.SendWork); len(work) != 0 {
		t.Fatalf("unknown send did not block FIFO: %#v", work)
	}
	unknown, err := s.GetOutbound(ctx, "one")
	if err != nil || unknown.Status != model.DeliveryUnknown {
		t.Fatalf("expiry: %#v %v", unknown, err)
	}
	if r := settle(t, s, first[0], at.Add(2*time.Minute), model.Sent); r.Status != model.Conflict {
		t.Fatalf("late settlement: %#v", r)
	}
	r, err := s.Requeue(ctx, model.RequeueInput{Kind: model.SendWork, ID: "one", ExpectedVersion: unknown.Version, Now: at.Add(2 * time.Minute)})
	if err != nil || r.Status != model.Conflict {
		t.Fatalf("unknown silently retried: %#v %v", r, err)
	}
	r, err = s.Requeue(ctx, model.RequeueInput{Kind: model.SendWork, ID: "one", ExpectedVersion: unknown.Version, Now: at.Add(2 * time.Minute), AcknowledgeUnknown: true})
	if err != nil || r.Status != model.Updated {
		t.Fatalf("acknowledged retry: %#v %v", r, err)
	}
	for range 2 {
		work := take(t, s, at.Add(2*time.Minute), model.SendWork)
		if len(work) != 1 || work[0].Outbound.DeliveryID != "one" {
			t.Fatal("FIFO did not retain first delivery")
		}
		settle(t, s, work[0], at.Add(2*time.Minute), model.Sent)
	}
	if work := take(t, s, at.Add(2*time.Minute), model.SendWork); len(work) != 1 || work[0].Outbound.DeliveryID != "two" {
		t.Fatalf("second delivery never resumed: %#v", work)
	}
}

func TestPendingPageFiltersInactiveOwnershipBeforeLimit(t *testing.T) {
	s := openStore(t, filepath.Join(t.TempDir(), "pending-scope.db"))
	initialize(t, s)
	at := time.Now().UTC()
	for i := range 22 {
		request := snapshot(fmt.Sprintf("old-%02d", i), at.Add(time.Duration(i)*time.Millisecond))
		if _, err := s.AcceptInbound(ctx, request, nil); err != nil {
			t.Fatal(err)
		}
	}
	changed := conversationRecord()
	changed.Endpoint.Config = json.RawMessage(`{"url":"https://changed.example.com"}`)
	if err := s.RegisterConversations(ctx, []model.ConversationRecord{changed}); err == nil {
		t.Fatal("same channel ID changed captured ownership")
	}
	// A changed endpoint owns a new channel identity. Old conversations become
	// inactive, so their many older requests must not consume the pending page.
	changed.Address.ID = "c-new"
	if err := s.RegisterConversations(ctx, []model.ConversationRecord{changed}); err != nil {
		t.Fatal(err)
	}
	request := snapshot("new", at.Add(time.Second))
	request.Channel = changed.Address
	request.Endpoint = changed.Endpoint
	if _, err := s.AcceptInbound(ctx, request, nil); err != nil {
		t.Fatal(err)
	}
	pending, err := s.ListPendingInbound(ctx, model.ListPendingInboundInput{ChannelIDs: []string{"c1", "c-new"}, EndpointIDs: []string{"agent"}, Limit: 20})
	if err != nil || len(pending) != 1 || pending[0].Snapshot.RequestID != "new" {
		t.Fatalf("stale ownership consumed page: %#v %v", pending, err)
	}
}
