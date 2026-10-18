package core

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/observability"
	"github.com/relanox/relanox/internal/storage"
)

// A live worker covers production invocation, but a completed queue alone only
// proves a zero-age sample. Real stored pending work protects the oldest-time
// calculation and reset, including retaining a stale sample after a DB failure.
func TestQueueStatisticsExposeOldestPendingAgeAndReset(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, config.Storage{Driver: "sqlite", Path: filepath.Join(t.TempDir(), "stats.db")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	observer, err := observability.New(config.Observability{Metrics: true}, observability.Options{Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := observer.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	conv := model.ConversationRecord{Address: model.ChannelAddress{ID: "c", Platform: model.Telegram, AccountID: "telegram", ChatID: "42"}, Endpoint: model.EndpointConfig{ID: "dot", Agent: model.Dot, Config: json.RawMessage(`{}`)}}
	if err := store.RegisterConversations(ctx, []model.ConversationRecord{conv}); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-2 * time.Hour)
	snapshot := model.InboundSnapshot{RequestID: "pending", Source: model.SourceKey{Channel: model.Telegram, AccountID: "telegram", EventID: "event"}, Channel: conv.Address, Endpoint: conv.Endpoint, Target: model.ReplyTarget{Channel: model.Telegram, AccountID: "telegram", ChatID: "42"}, AcceptedAt: at, ReceivedAt: at, Text: "pending input"}
	if _, err := store.AcceptInbound(ctx, snapshot, nil); err != nil {
		t.Fatal(err)
	}
	r := &Runtime{store: store, observe: observer}
	r.refreshStats(ctx)
	if age := queueGauge(t, observer, "relanox_oldest_pending_age_seconds"); age < 7200 || age >= 7260 {
		t.Fatalf("two-hour pending age=%f", age)
	}
	now := time.Now()
	work, err := store.TakeDue(ctx, model.TakeDueInput{Now: now, LeaseDuration: time.Minute, LeaseOwner: "stats", Limit: 1})
	if err != nil || len(work) != 1 {
		t.Fatalf("claim: %#v %v", work, err)
	}
	settled, err := store.SettleAttempt(ctx, model.Settlement{Kind: model.DispatchWork, ID: "pending", Lease: work[0].Lease, Now: now, Dispatch: &model.DispatchResult{Status: model.Accepted}})
	if err != nil || settled.Status != model.Updated {
		t.Fatalf("settle: %#v %v", settled, err)
	}
	r.refreshStats(ctx)
	if age := queueGauge(t, observer, "relanox_oldest_pending_age_seconds"); age != 0 {
		t.Fatalf("empty queue retained age=%f", age)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	r.refreshStats(ctx)
	if stale := queueGauge(t, observer, "relanox_storage_stats_stale"); stale != 1 {
		t.Fatalf("failed stats stale=%f", stale)
	}
}

func queueGauge(t *testing.T, observer *observability.Observer, name string) float64 {
	t.Helper()
	response := httptest.NewRecorder()
	observer.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	for line := range strings.SplitSeq(response.Body.String(), "\n") {
		if !strings.HasPrefix(line, name+"{") {
			continue
		}
		end := strings.LastIndexByte(line, '}')
		if end < 0 {
			continue
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(line[end+1:]), 64)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	t.Fatalf("missing metric %s", name)
	return 0
}
