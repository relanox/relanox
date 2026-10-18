package core_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/telegram"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/observability"
	"github.com/relanox/relanox/internal/storage"
)

type telegramQueueFixture struct {
	runtime   *core.Runtime
	store     *storage.Store
	host      model.ChannelHost
	agent     model.ScopedAgentHost
	deadlines chan time.Duration
	target    model.ReplyTarget
}

// Telegram Bot API ResponseParameters.retry_after is an integer number of
// seconds: https://core.telegram.org/bots/api#responseparameters . The peer only
// returns native HTTP receipts; all scheduling and persistence remain real.
func newTelegramQueueFixture(t *testing.T, handler http.Handler, options core.Options) *telegramQueueFixture {
	t.Helper()
	peer := httptest.NewServer(handler)
	routine := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.Copy(io.Discard, r.Body); w.WriteHeader(200) }))
	t.Cleanup(peer.Close)
	t.Cleanup(routine.Close)
	account := model.AccountConfig{ID: "telegram", Channel: model.Telegram, AllowedSenders: []string{"7"}, Config: common.Data(telegram.Config{BotToken: model.SecretRef{Env: "TELEGRAM_TOKEN"}, WebhookSecret: model.SecretRef{Env: "TELEGRAM_WEBHOOK"}, APIBaseURL: peer.URL, AllowInsecureLoopback: true})}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Token: model.SecretRef{Env: "MCP"}}, RoutineURL: model.SecretRef{Env: "ROUTINE"}, RoutineAuthorization: model.SecretRef{Env: "ROUTINE_AUTH"}})}
	cfg := relayConfig(t, "https://relay.example", account, endpoint, filepath.Join(t.TempDir(), "queue.db"))
	cfg.Bindings[0].ChatID = "42"
	f := &telegramQueueFixture{deadlines: make(chan time.Duration, 4)}
	var err error
	f.store, err = storage.Open(context.Background(), cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.store.Close() })
	f.runtime, err = core.New(cfg, f.store, options)
	if err != nil {
		t.Fatal(err)
	}
	f.host, err = f.runtime.ChannelHost(account.ID)
	if err != nil {
		t.Fatal(err)
	}
	resolve := func(ref model.SecretRef) (string, error) {
		return map[string]string{"TELEGRAM_TOKEN": "123:public-token", "TELEGRAM_WEBHOOK": "public-webhook", "MCP": "mcp-token", "ROUTINE": routine.URL, "ROUTINE_AUTH": "Bearer public"}[ref.Env], nil
	}
	nativeClient := *peer.Client()
	nativeClient.Transport = deadlineTransport{base: nativeClient.Transport, samples: f.deadlines}
	channel, err := telegram.New(f.host, account, common.Options{HTTPClient: &nativeClient, ResolveSecret: resolve})
	if err != nil {
		t.Fatal(err)
	}
	resolution, err := channel.Resolve(context.Background(), f.host.BoundAddresses()[0], nil)
	if err != nil || resolution.Target == nil {
		t.Fatalf("native target: %#v %v", resolution, err)
	}
	f.target = *resolution.Target
	if err = f.runtime.AttachChannel(account.ID, channel); err != nil {
		t.Fatal(err)
	}
	host, err := f.runtime.AgentHost(model.Grok)
	if err != nil {
		t.Fatal(err)
	}
	agent, err := grok.New(endpoint, agentmcp.Dependencies{Host: host, ResolveSecret: resolve, HTTPClient: routine.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runtime.AttachAgent(endpoint.ID, agent); err != nil {
		t.Fatal(err)
	}
	f.agent, err = host.ForPrincipal(context.Background(), model.Principal{Subject: "queue-test", EndpointIDs: []string{"grok"}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := f.runtime.Close(shutdown); err != nil {
			t.Error(err)
		}
	})
	if err = f.runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *telegramQueueFixture) enqueue(t *testing.T) model.MessageReceipt {
	t.Helper()
	receipt, err := f.host.Ingest(context.Background(), model.IngestInput{Source: model.SourceKey{Channel: model.Telegram, AccountID: "telegram", EventID: "native-event"}, SenderID: "7", Text: "incoming", Target: f.target, ReceivedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	record := awaitInboundRecord(t, f.store, receipt.RequestID, model.AttemptAccepted)
	queued, err := f.agent.SendMessage(context.Background(), model.SendMessageInput{Channel: record.Snapshot.Channel.ID, Text: "answer", IdempotencyKey: "native-answer"})
	if err != nil || queued.Status != model.Queued {
		t.Fatalf("queue: %#v %v", queued, err)
	}
	return queued
}

// A native 48-hour flood control receipt must survive worker settlement. Earlier
// native tests stopped at adapter outcomes, so the worker's 24-hour truncation
// was invisible. This uses the production native SDK, worker and real SQLite.
func TestNativeRetryAfterSurvivesWorkerSettlement(t *testing.T) {
	f := newTelegramQueueFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":172800}}`)
	}), core.Options{})
	before := time.Now()
	queued := f.enqueue(t)
	var settled *model.OutboundRecord
	waitForQueue(t, "native 48-hour retry settlement", func(ctx context.Context) (bool, string, error) {
		record, err := f.store.GetOutbound(ctx, queued.DeliveryID)
		if err != nil || record == nil {
			return false, "delivery unavailable", err
		}
		settled = record
		return record.Attempts == 1 && record.Lease == nil, string(record.Status), nil
	})
	if settled.Status != model.DeliveryPending || settled.DueAt.Before(before.Add(48*time.Hour)) || settled.DueAt.After(time.Now().Add(48*time.Hour)) {
		t.Fatalf("native retry deadline must retain 48 hours: status=%s delay=%s", settled.Status, settled.DueAt.Sub(before))
	}
}

// This transport only observes the context passed to real native HTTP I/O and
// delegates unchanged. It neither chooses an outcome nor schedules work.
type deadlineTransport struct {
	base    http.RoundTripper
	samples chan time.Duration
}

func (d deadlineTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if strings.HasSuffix(request.URL.Path, "/sendMessage") {
		deadline, ok := request.Context().Deadline()
		if ok {
			d.samples <- time.Until(deadline)
		} else {
			d.samples <- 0
		}
	}
	return d.base.RoundTrip(request)
}

func nativeSendSuccess(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, r.Body)
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true,"result":{"message_id":99,"date":0,"chat":{"id":42,"type":"private"},"text":"answer"}}`)
}

// A healthy native send receives the 600-second operation budget while the
// durable lease still reserves settlement time. Prior native tests only checked
// outcomes, so a shortened context was invisible. Real HTTP I/O is instrumented.
func TestNativeSendReceivesFullOperationBudget(t *testing.T) {
	f := newTelegramQueueFixture(t, http.HandlerFunc(nativeSendSuccess), core.Options{})
	queued := f.enqueue(t)
	awaitDelivery(t, f.store, queued.DeliveryID, model.DeliverySent)
	select {
	case budget := <-f.deadlines:
		if budget < 599*time.Second || budget > 600*time.Second {
			t.Fatalf("native send budget=%s; want 600s", budget)
		}
	default:
		t.Fatal("native HTTP deadline not observed")
	}
}

// Registration alone cannot establish working gauges. A real completed native
// queue operation must expose success/age/freshness, and a later store failure
// must mark its retained statistics stale. Adapter trace tests missed these.
func TestWorkerPublishesLiveAndStaleQueueStatistics(t *testing.T) {
	observer, err := observability.New(config.Observability{Metrics: true}, observability.Options{Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := observer.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	f := newTelegramQueueFixture(t, http.HandlerFunc(nativeSendSuccess), core.Options{Observer: observer})
	queued := f.enqueue(t)
	awaitDelivery(t, f.store, queued.DeliveryID, model.DeliverySent)
	waitForQueue(t, "live worker gauges", func(context.Context) (bool, string, error) {
		text := scrapeWorkerMetrics(observer)
		for _, name := range []string{"relanox_worker_last_success_timestamp_seconds", "relanox_oldest_pending_age_seconds", "relanox_storage_stats_stale"} {
			if !strings.Contains(text, name+"{") {
				return false, "missing " + name, nil
			}
		}
		return metricHasValue(text, "relanox_storage_stats_stale", 0) && !metricHasValue(text, "relanox_worker_last_success_timestamp_seconds", 0), "freshness and successful work timestamp", nil
	})
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	waitForQueue(t, "failed statistics marked stale", func(context.Context) (bool, string, error) {
		return metricHasValue(scrapeWorkerMetrics(observer), "relanox_storage_stats_stale", 1), "stale gauge", nil
	})
}

func scrapeWorkerMetrics(observer *observability.Observer) string {
	response := httptest.NewRecorder()
	observer.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	return response.Body.String()
}

func metricHasValue(text, name string, value float64) bool {
	for line := range strings.SplitSeq(text, "\n") {
		if !strings.HasPrefix(line, name+"{") {
			continue
		}
		closeIndex := strings.LastIndexByte(line, '}')
		if closeIndex < 0 {
			continue
		}
		var actual float64
		if _, err := fmt.Sscanf(line[closeIndex+1:], "%f", &actual); err == nil && actual == value {
			return true
		}
	}
	return false
}

// Counter registration is insufficient: real native retries must increment the
// externally consumed delivery/retry series. The work counter is a control that
// proves the observer accepted metrics, independent of label spelling.
func TestNativeRetryUpdatesDeliveryAndRetryCounters(t *testing.T) {
	observer, err := observability.New(config.Observability{Metrics: true}, observability.Options{Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := observer.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	f := newTelegramQueueFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(429)
		_, _ = io.WriteString(w, `{"ok":false,"error_code":429,"parameters":{"retry_after":172800}}`)
	}), core.Options{Observer: observer})
	queued := f.enqueue(t)
	waitForQueue(t, "native retry counter settlement", func(ctx context.Context) (bool, string, error) {
		record, err := f.store.GetOutbound(ctx, queued.DeliveryID)
		return record != nil && record.Attempts == 1, "retry count", err
	})
	text := scrapeWorkerMetrics(observer)
	if !metricHasValue(text, "relanox_work_total", 1) {
		t.Fatal("observer did not receive completed work control")
	}
	for _, name := range []string{"relanox_delivery_total", "relanox_retries_total"} {
		if !metricHasValue(text, name, 1) {
			t.Errorf("completed native retry did not update %s", name)
		}
	}
}

// Warn-level operation logs must retain rejected and ambiguous native effects;
// safely retryable receipts remain info. Earlier tests checked output fields at
// info and could not detect that failures were removed by a warn-level filter.
func TestWorkerWarningLogsRetainRejectedAndUnknownOutcomes(t *testing.T) {
	for _, test := range []struct {
		name    string
		code    int
		want    model.DeliveryStatus
		warning bool
	}{
		{name: "rejected", code: 403, want: model.DeliveryRejected, warning: true},
		{name: "unknown", code: 408, want: model.DeliveryUnknown, warning: true},
		{name: "retryable", code: 429, want: model.DeliveryPending},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			observer, err := observability.New(config.Observability{Level: "warn"}, observability.Options{Writer: &logs})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := observer.Close(context.Background()); err != nil {
					t.Error(err)
				}
			})
			f := newTelegramQueueFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.code)
				receipt := map[string]any{"ok": false, "error_code": test.code, "description": "native fixture receipt"}
				if test.code == 429 {
					receipt["parameters"] = map[string]int{"retry_after": 172800}
				}
				_ = json.NewEncoder(w).Encode(receipt)
			}), core.Options{Observer: observer})
			queued := f.enqueue(t)
			waitForQueue(t, "native warning outcome", func(ctx context.Context) (bool, string, error) {
				record, err := f.store.GetOutbound(ctx, queued.DeliveryID)
				return record != nil && record.Attempts == 1 && record.Status == test.want, "native outcome", err
			})
			if err := observer.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			decoder := json.NewDecoder(&logs)
			found := false
			for {
				var entry map[string]any
				err := decoder.Decode(&entry)
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				if entry["event"] == "work.completed" {
					if entry["level"] != "warn" || entry["outcome"] != test.name {
						t.Fatalf("unexpected operation log: %#v", entry)
					}
					found = true
				}
			}
			if found != test.warning {
				t.Fatalf("warning log present=%v; want=%v", found, test.warning)
			}
		})
	}
}
