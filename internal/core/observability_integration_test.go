package core_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/observability"
	"github.com/relanox/relanox/internal/speech"
	collector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

// A real Tencent preparer, native Grok/WeChat, MCP, SQLite queues and OTLP HTTP
// expose the complete production trace. Before this instrumentation only ingest
// emitted spans and Outbound.Trace was empty; provider-only tests missed both
// durable queue breaks. All external peers implement only their wire protocols:
// https://opentelemetry.io/docs/specs/otlp/#otlphttp
// https://cloud.tencent.com/document/api/1093/35646
func TestNativePreparedFinalReplyKeepsTraceAcrossDurableQueues(t *testing.T) {
	requests := make(chan *collector.ExportTraceServiceRequest, 8)
	collectorPeer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		var request collector.ExportTraceServiceRequest
		if err != nil || proto.Unmarshal(data, &request) != nil {
			t.Error("invalid OTLP protobuf request")
			w.WriteHeader(400)
			return
		}
		requests <- &request
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	t.Cleanup(collectorPeer.Close)
	observer, err := observability.New(config.Observability{Metrics: true, OTLPEndpoint: collectorPeer.URL}, observability.Options{Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeTraceObserver(t, observer) })
	preparer := tracedSpeech(t)
	f := newRelayFixture(t, core.Options{Observer: observer, Preparers: []model.Preparer{preparer}})
	initial := awaitInbound(t, f.store, model.AttemptAccepted)
	receipt, err := f.host.Ingest(f.ctx, model.IngestInput{Source: model.SourceKey{Channel: model.WeChat, AccountID: "wechat", EventID: "traced-audio"}, SenderID: "alice", Text: "original caption", Target: initial.Snapshot.Target, ReceivedAt: time.Now(), Attachments: []model.MediaUpload{{Kind: model.Audio, MIMEType: "audio/wav", FileName: "voice.wav", Data: []byte("abc")}}})
	if err != nil {
		t.Fatal(err)
	}
	record := waitTracedInbound(t, f, receipt.RequestID)
	if record.Snapshot.Trace == nil || len(record.Preparation) != 1 || record.Preparation[0].Output == nil || !strings.Contains(record.Preparation[0].Output.Text, "native transcript") {
		t.Fatalf("real prepared input not retained: %#v", record)
	}
	session := connectMCP(t, f)
	queued := callTool[model.MessageReceipt](t, f, session, "relanox_send_message", map[string]any{"channel": record.Snapshot.Channel.ID, "text": "traced final reply", "idempotencyKey": "trace-final", "reply": map[string]string{"requestId": receipt.RequestID, "kind": "final"}})
	awaitDelivery(t, f.store, queued.DeliveryID, model.DeliverySent)
	delivery, err := f.store.GetOutbound(f.ctx, queued.DeliveryID)
	if err != nil || delivery == nil || delivery.Trace == nil {
		t.Fatalf("outbound trace was not persisted: %#v %v", delivery, err)
	}
	closeTraceObserver(t, observer)
	traceID := strings.Split(record.Snapshot.Trace.Traceparent, "-")[1]
	spans := collectNativeSpans(requests, traceID)
	assertNativeTraceGraph(t, spans, strings.Split(delivery.Trace.Traceparent, "-")[2])
	metrics := httptest.NewRecorder()
	observer.Handler().ServeHTTP(metrics, httptest.NewRequest("GET", "/metrics", nil))
	for _, name := range []string{"relanox_preparation_duration_seconds_count", "relanox_dispatch_duration_seconds_count", "relanox_send_duration_seconds_count"} {
		if !strings.Contains(metrics.Body.String(), name+"{") {
			t.Fatalf("worker duration missing: %s", name)
		}
	}
	// Registered counters must receive the actual completed preparation and
	// native dispatch/send outcomes; span and duration coverage alone missed it.
	for _, metric := range []struct {
		name string
		want float64
	}{{"relanox_middleware_total", 1}, {"relanox_dispatch_total", 2}, {"relanox_delivery_total", 1}} {
		if !metricHasValue(metrics.Body.String(), metric.name, metric.want) {
			t.Fatalf("completed native operation did not update %s to %g", metric.name, metric.want)
		}
	}
}

func tracedSpeech(t *testing.T) *speech.Preparer {
	t.Helper()
	peer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, `{"Response":{"Result":"native transcript","WordList":null,"RequestId":"41ed9283-0c09-46fb-917b-0b83fa95f0be"}}`)
	}))
	t.Cleanup(peer.Close)
	client := *peer.Client()
	target, _ := url.Parse(peer.URL)
	client.Transport = asrTraceTransport{base: client.Transport, target: target}
	preparer, err := speech.New(config.Speech{Enabled: true, EngineModelType: "16k_en", SecretID: model.SecretRef{Env: "ASR_ID"}, SecretKey: model.SecretRef{Env: "ASR_KEY"}}, speech.Options{HTTPClient: &client, ResolveSecret: func(model.SecretRef) (string, error) { return "public-fixture", nil }})
	if err != nil {
		t.Fatal(err)
	}
	return preparer
}

type asrTraceTransport struct {
	base   http.RoundTripper
	target *url.URL
}

func (t asrTraceTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	u := *request.URL
	u.Scheme, u.Host = t.target.Scheme, t.target.Host
	request.URL = &u
	return t.base.RoundTrip(request)
}

func waitTracedInbound(t *testing.T, f *relayFixture, id string) *model.InboundRecord {
	t.Helper()
	return awaitInboundRecord(t, f.store, id, model.AttemptAccepted)
}

func closeTraceObserver(t *testing.T, observer *observability.Observer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := observer.Close(ctx); err != nil {
		t.Error(err)
	}
}

func collectNativeSpans(requests <-chan *collector.ExportTraceServiceRequest, traceID string) map[string]*tracepb.Span {
	spans := map[string]*tracepb.Span{}
	for {
		select {
		case request := <-requests:
			collectRequestSpans(spans, request, traceID)
		default:
			return spans
		}
	}
}

func collectRequestSpans(spans map[string]*tracepb.Span, request *collector.ExportTraceServiceRequest, traceID string) {
	for _, resource := range request.ResourceSpans {
		for _, scope := range resource.ScopeSpans {
			for _, span := range scope.Spans {
				if hex.EncodeToString(span.TraceId) == traceID {
					spans[span.Name] = span
				}
			}
		}
	}
}

func assertNativeTraceGraph(t *testing.T, spans map[string]*tracepb.Span, durableEnqueueID string) {
	t.Helper()
	for _, name := range []string{"ingest", "prepare", "dispatch", "enqueue_message", "send"} {
		if spans[name] == nil {
			t.Fatalf("native trace misses %s: %v", name, spans)
		}
	}
	for _, child := range []string{"prepare", "dispatch", "enqueue_message"} {
		if !bytes.Equal(spans[child].ParentSpanId, spans["ingest"].SpanId) {
			t.Fatalf("captured inbound trace disconnected at %s", child)
		}
	}
	if !bytes.Equal(spans["send"].ParentSpanId, spans["enqueue_message"].SpanId) || hex.EncodeToString(spans["enqueue_message"].SpanId) != durableEnqueueID {
		t.Fatal("outbound queue disconnected final reply trace")
	}
}
