package observability_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/observability"
)

// Public log/HTTP contracts protect secret redaction, private finite metric
// labels and independent instances. An arbitrary diagnostic or identity leaking
// through a typed string fails here; Go type checking and core noop-observer
// tests cannot catch that. Writer is a production sink option, not a new seam.
func TestStructuredLogsAndMetricsRejectUntrustedFields(t *testing.T) {
	var logs bytes.Buffer
	observer, err := observability.New(config.Observability{Level: "info", Metrics: true}, observability.Options{Writer: &logs})
	if err != nil {
		t.Fatal(err)
	}
	observer.Log(context.Background(), "debug", "startup.completed", model.LogFields{Component: "cli"})
	observer.Log(context.Background(), "info", "inbound.accepted", model.LogFields{Component: "core", RequestID: "00112233-4455-6677-8899-aabbccddeeff", Outcome: "accepted", Operation: "ingest"})
	observer.Log(context.Background(), "warn", "private-token-event", model.LogFields{Component: "private-token-component", RequestID: "private-token-request", ChannelID: "private-token-channel", ErrorCode: "private-token-error", TraceID: "private-token-trace"})
	observer.Log(context.Background(), "warn", "connection.changed", model.LogFields{Component: "channel:wechat", ErrorCode: "wechat_rate_limited"})
	observer.Count("relanox_inbound_total", model.MetricLabels{Channel: model.WeChat, Component: "core", Operation: "ingest", Outcome: "accepted"}, 3)
	observer.Count("relanox_inbound_total", model.MetricLabels{Component: "private-token-component"}, 100)
	observer.Count("private-token-metric", model.MetricLabels{}, 100)
	observer.Record("relanox_pending", 7, model.MetricLabels{})
	closeObserver(t, observer)
	var entries []map[string]string
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var entry map[string]string
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, entry)
	}
	if len(entries) != 3 || entries[0]["requestId"] != "00112233-4455-6677-8899-aabbccddeeff" || entries[1]["event"] != "operation.failed" || entries[1]["errorCode"] != "unknown" || entries[2]["errorCode"] != "wechat_rate_limited" || strings.Contains(logs.String(), "private-token") {
		t.Fatalf("unsafe structured logs: %s", logs.String())
	}
	metrics := scrape(t, observer)
	if strings.Contains(metrics, "private-token") || !strings.Contains(metrics, `relanox_inbound_total{agent="",channel="wechat",error_class="",operation="ingest",outcome="accepted",plugin="core"} 3`) || !strings.Contains(metrics, `relanox_pending{agent="",channel="",error_class="",operation="",outcome="",plugin=""} 7`) || !strings.Contains(metrics, `relanox_telemetry_dropped_total{signal="metrics"} 2`) {
		t.Fatalf("metric validation or values lost: %s", metrics)
	}
	other, err := observability.New(config.Observability{Metrics: true}, observability.Options{Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer closeObserver(t, other)
	if strings.Contains(scrape(t, other), "relanox_inbound_total{") {
		t.Fatal("metric registry leaked between instances")
	}
}

func TestMetricsBoundSeriesAndRespectHTTPConfiguration(t *testing.T) {
	observer, err := observability.New(config.Observability{Metrics: true}, observability.Options{Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer closeObserver(t, observer)
	channels := []model.ChannelKind{model.Telegram, model.Discord, model.Slack, model.Feishu, model.WeCom, model.WeChat, model.DingTalk, model.QQ, model.MSTeams, model.WhatsApp, model.Matrix, model.GoogleChat, model.LINE, model.Mattermost, model.Signal, model.IRC}
	outcomes := []string{"accepted", "rejected", "unknown", "retryable", "sent"}
	recordSupportedWorkerMatrix(observer, channels)
	metrics := scrape(t, observer)
	if strings.Count(metrics, "\nrelanox_work_total{") != 94 || !strings.Contains(metrics, `relanox_telemetry_dropped_total{signal="metrics"} 0`) {
		t.Fatalf("supported native work matrix was dropped: %s", metrics)
	}
	for _, operation := range []string{"ingest", "dispatch", "prepare", "send"} {
		for _, outcome := range outcomes {
			for _, channel := range channels {
				observer.Count("relanox_inbound_total", model.MetricLabels{Channel: channel, Outcome: outcome, Operation: operation}, 1)
			}
		}
	}
	metrics = scrape(t, observer)
	if strings.Count(metrics, "\nrelanox_inbound_total{") != 256 || !strings.Contains(metrics, `relanox_telemetry_dropped_total{signal="metrics"} 64`) {
		t.Fatalf("series limit not enforced: %s", metrics)
	}
	assertMetricsHTTPConfiguration(t, observer)
}

func recordSupportedWorkerMatrix(observer *observability.Observer, channels []model.ChannelKind) {
	for _, outcome := range []string{"sent", "pending", "rejected", "retryable", "unknown"} {
		for _, channel := range channels {
			observer.Count("relanox_work_total", model.MetricLabels{Component: "core", Channel: channel, Operation: "send", Outcome: outcome}, 1)
		}
	}
	for _, outcome := range []string{"accepted", "rejected", "retryable", "unknown"} {
		for _, agent := range []model.AgentKind{model.Dot, model.Grok, model.Muse} {
			observer.Count("relanox_work_total", model.MetricLabels{Component: "core", Agent: agent, Operation: "dispatch", Outcome: outcome}, 1)
		}
	}
	for _, outcome := range []string{"prepared", "failed"} {
		observer.Count("relanox_work_total", model.MetricLabels{Component: "core", Operation: "prepare", Outcome: outcome}, 1)
	}
}

func assertMetricsHTTPConfiguration(t *testing.T, observer *observability.Observer) {
	t.Helper()
	server := httptest.NewServer(observer.Handler())
	defer server.Close()
	response, err := server.Client().Post(server.URL, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 405 || response.Header.Get("Allow") != "GET, HEAD" {
		t.Fatal("metrics method boundary changed")
	}
	disabled, err := observability.New(config.Observability{}, observability.Options{Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer closeObserver(t, disabled)
	recorder := httptest.NewRecorder()
	disabled.Handler().ServeHTTP(recorder, httptest.NewRequest("GET", "/metrics", nil))
	if recorder.Code != 404 {
		t.Fatal("disabled metrics remained exposed")
	}
}

// A real blocked pipe simulates backpressure at a log destination. A synchronous
// writer would stall relay work; an unbounded queue would retain all 300 events.
// The shutdown deadline remains observable without a fake writer implementation.
func TestLogBackpressureIsBoundedAndShutdownHonorsDeadline(t *testing.T) {
	reader, writer := io.Pipe()
	defer func() { _ = reader.Close() }()
	defer func() { _ = writer.Close() }()
	observer, err := observability.New(config.Observability{Metrics: true}, observability.Options{Writer: writer})
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	go func() {
		for range 300 {
			observer.Log(context.Background(), "info", "work.completed", model.LogFields{Component: "core"})
		}
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("relay blocked on log destination")
	}
	if strings.Contains(scrape(t, observer), `relanox_telemetry_dropped_total{signal="logs"} 0`) {
		t.Fatal("blocked logs grew without bounded drops")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := observer.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked log shutdown: %v", err)
	}
	_ = reader.Close()
}

// A timed-out caller must not mark an active log writer as joined. The existing
// backpressure test only observes the first Close deadline. A real pipe keeps a
// production sink write active until its bytes are drained; no new seam is used.
func TestLogShutdownCanBeJoinedAfterCallerDeadline(t *testing.T) {
	reader, writer := io.Pipe()
	defer func() { _ = reader.Close() }()
	defer func() { _ = writer.Close() }()
	observer, err := observability.New(config.Observability{}, observability.Options{Writer: writer})
	if err != nil {
		t.Fatal(err)
	}
	observer.Log(context.Background(), "info", "work.completed", model.LogFields{Component: "core"})
	var first [1]byte
	if _, err := io.ReadFull(reader, first[:]); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := observer.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked sink did not honor caller deadline: %v", err)
	}
	joined := make(chan error, 1)
	go func() { joined <- observer.Close(context.Background()) }()
	select {
	case err := <-joined:
		t.Fatalf("shutdown returned before pending log drained: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	var rest bytes.Buffer
	for !bytes.Contains(rest.Bytes(), []byte{'\n'}) {
		var next [1]byte
		if _, err := io.ReadFull(reader, next[:]); err != nil {
			t.Fatal(err)
		}
		rest.WriteByte(next[0])
	}
	select {
	case err := <-joined:
		if err != nil {
			t.Fatalf("drained sink retained caller timeout: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("drained log writer was not joined")
	}
}

func closeObserver(t *testing.T, observer *observability.Observer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := observer.Close(ctx); err != nil {
		t.Error(err)
	}
}

func scrape(t *testing.T, observer *observability.Observer) string {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/metrics", nil)
	request.Header.Set("Accept", "text/plain; version=0.0.4")
	observer.Handler().ServeHTTP(recorder, request)
	if recorder.Code != 200 || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("metrics HTTP: %d", recorder.Code)
	}
	return recorder.Body.String()
}
