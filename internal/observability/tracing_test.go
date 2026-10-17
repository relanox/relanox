package observability_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/observability"
	"go.opentelemetry.io/otel"
	collector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

// Actual OTLP protobuf over HTTP protects remote-parent propagation, sanitized
// span attributes, batch flushing and explicit collector configuration. The
// peer implements only the official CollectorService wire protocol:
// https://opentelemetry.io/docs/specs/otlp/#otlphttp
// Previous logging/metrics tests export no traces. No exporter mock or extra
// production seam is used; local collector URLs are supported configuration.
func TestOTLPExportsLinkedSanitizedSpansWithoutGlobalState(t *testing.T) {
	requests := make(chan *collector.ExportTraceServiceRequest, 4)
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		var request collector.ExportTraceServiceRequest
		if err != nil || proto.Unmarshal(data, &request) != nil || r.URL.Path != "/v1/traces" || r.Header.Get("Content-Type") != "application/x-protobuf" || r.Header.Get("Authorization") != "" || r.Header.Get("Content-Encoding") != "" {
			t.Error("unexpected OTLP protobuf request or inherited environment headers")
			w.WriteHeader(400)
			return
		}
		requests <- &request
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer peer.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=private-environment-token")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:1/wrong-collector")
	t.Setenv("OTEL_EXPORTER_OTLP_COMPRESSION", "gzip")
	global := otel.GetTracerProvider()
	var logs bytes.Buffer
	observer, err := observability.New(config.Observability{Metrics: true, OTLPEndpoint: peer.URL}, observability.Options{Writer: &logs})
	if err != nil {
		t.Fatal(err)
	}
	parent := &model.TraceContext{Traceparent: "00-00112233445566778899aabbccddeeff-1122334455667788-01", Tracestate: "private-vendor=private-trace-token"}
	ctx, first := observer.Span(context.Background(), "ingest", model.LogFields{Component: "core", RequestID: "private-request-token", ErrorCode: "private-error-token"}, parent)
	if first.Context() == nil || !strings.HasPrefix(first.Context().Traceparent, "00-00112233445566778899aabbccddeeff-") || first.Context().Tracestate != "" {
		t.Fatalf("durable trace context: %#v", first.Context())
	}
	_, child := observer.Span(ctx, "dispatch", model.LogFields{Component: "agent:grok", Operation: "dispatch"}, nil)
	observer.Log(ctx, "info", "inbound.accepted", model.LogFields{Component: "core"})
	child.End("accepted")
	child.End("failed")
	first.End("accepted")
	closeObserver(t, observer)
	if otel.GetTracerProvider() != global {
		t.Fatal("observer replaced process-global tracer provider")
	}
	if !strings.Contains(logs.String(), `"traceId":"00112233445566778899aabbccddeeff"`) || strings.Contains(logs.String(), "private-") {
		t.Fatalf("trace/log correlation or redaction lost: %s", logs.String())
	}
	select {
	case request := <-requests:
		assertOTLPSpans(t, request)
	default:
		t.Fatal("shutdown did not flush OTLP batch")
	}
}

func assertOTLPSpans(t *testing.T, request *collector.ExportTraceServiceRequest) {
	t.Helper()
	var spans []*tracepb.Span
	for _, resource := range request.ResourceSpans {
		for _, scope := range resource.ScopeSpans {
			spans = append(spans, scope.Spans...)
		}
	}
	if len(spans) != 2 {
		t.Fatalf("idempotent span end changed: %d", len(spans))
	}
	byName := map[string]*tracepb.Span{}
	for _, span := range spans {
		byName[span.Name] = span
		if hex.EncodeToString(span.TraceId) != "00112233445566778899aabbccddeeff" || strings.Contains(span.String(), "private-") || span.TraceState != "" {
			t.Fatalf("unsafe OTLP span: %s", span)
		}
	}
	if byName["ingest"] == nil || byName["dispatch"] == nil || hex.EncodeToString(byName["ingest"].ParentSpanId) != "1122334455667788" || !bytes.Equal(byName["dispatch"].ParentSpanId, byName["ingest"].SpanId) || byName["dispatch"].Status.Code != tracepb.Status_STATUS_CODE_OK {
		t.Fatalf("OTLP parent or native outcome changed: %v", byName)
	}
}

func TestOTLPDoesNotFollowCollectorRedirect(t *testing.T) {
	var redirected atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1); w.WriteHeader(200) }))
	defer target.Close()
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer peer.Close()
	observer, err := observability.New(config.Observability{Metrics: true, OTLPEndpoint: peer.URL + "/v1/traces"}, observability.Options{Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	_, span := observer.Span(context.Background(), "ingest", model.LogFields{Component: "core"}, nil)
	span.End("accepted")
	closeObserver(t, observer)
	if redirected.Load() != 0 || !strings.Contains(scrape(t, observer), `relanox_telemetry_dropped_total{signal="traces"} 1`) {
		t.Fatal("OTLP followed redirect or failed export was not counted")
	}
}
