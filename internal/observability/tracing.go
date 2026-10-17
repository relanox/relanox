package observability

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/relanox/relanox/internal/model"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func (o *Observer) initTracing() error {
	if o.cfg.OTLPEndpoint == "" {
		return nil
	}
	endpoint, _ := url.Parse(o.cfg.OTLPEndpoint)
	if endpoint.Path == "" || endpoint.Path == "/" {
		endpoint.Path = "/v1/traces"
	}
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext, TLSHandshakeTimeout: 2 * time.Second, ResponseHeaderTimeout: 2 * time.Second, MaxResponseHeaderBytes: 1 << 20, IdleConnTimeout: 30 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	exporter, err := otlptracehttp.New(context.Background(), otlptracehttp.WithEndpointURL(endpoint.String()), otlptracehttp.WithHTTPClient(client), otlptracehttp.WithHeaders(map[string]string{}), otlptracehttp.WithCompression(otlptracehttp.NoCompression), otlptracehttp.WithEncoding(otlptracehttp.EncodingProtobuf), otlptracehttp.WithMaxRequestSize(1<<20), otlptracehttp.WithMaxResponseSize(1<<20), otlptracehttp.WithTimeout(2*time.Second), otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}))
	if err != nil {
		return errors.New("tracing_exporter_unavailable")
	}
	o.provider = sdktrace.NewTracerProvider(sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", "relanox"))), sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.AlwaysSample())), sdktrace.WithRawSpanLimits(sdktrace.SpanLimits{AttributeCountLimit: 12, AttributeValueLengthLimit: 128}), sdktrace.WithBatcher(safeExporter{SpanExporter: exporter, drop: func() { o.drop("traces") }}, sdktrace.WithMaxQueueSize(512), sdktrace.WithMaxExportBatchSize(128), sdktrace.WithBatchTimeout(time.Second), sdktrace.WithExportTimeout(2*time.Second)))
	o.tracer = o.provider.Tracer("relanox")
	return nil
}

type safeExporter struct {
	sdktrace.SpanExporter
	drop func()
}

func (e safeExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	if err := e.SpanExporter.ExportSpans(ctx, spans); err != nil {
		e.drop()
		// Telemetry is best effort. Count the failed batch locally instead of
		// passing collector diagnostics into the SDK's process-global logger.
		return nil
	}
	return nil
}

func (o *Observer) Span(ctx context.Context, name string, fields model.LogFields, parent *model.TraceContext) (context.Context, model.Span) {
	if o.closed.Load() || o.tracer == nil || !operations[name] {
		return ctx, noopSpan{}
	}
	if remote, ok := remoteParent(parent); ok {
		ctx = trace.ContextWithRemoteSpanContext(ctx, remote)
	}
	attributes := []attribute.KeyValue{}
	for key, value := range safeFields(fields) {
		attributes = append(attributes, attribute.String(key, value))
	}
	ctx, span := o.tracer.Start(ctx, name, trace.WithAttributes(attributes...))
	return ctx, &spanHandle{span: span}
}

func remoteParent(parent *model.TraceContext) (trace.SpanContext, bool) {
	if parent == nil {
		return trace.SpanContext{}, false
	}
	parts := strings.Split(parent.Traceparent, "-")
	if len(parts) != 4 || parts[0] != "00" || parts[3] != "00" && parts[3] != "01" {
		return trace.SpanContext{}, false
	}
	traceID, err := trace.TraceIDFromHex(parts[1])
	if err != nil {
		return trace.SpanContext{}, false
	}
	spanID, err := trace.SpanIDFromHex(parts[2])
	if err != nil {
		return trace.SpanContext{}, false
	}
	flags := trace.TraceFlags(0)
	if parts[3] == "01" {
		flags = trace.FlagsSampled
	}
	result := trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID, TraceFlags: flags, Remote: true})
	return result, result.IsValid()
}

type noopSpan struct{}

func (noopSpan) Context() *model.TraceContext { return nil }

func (noopSpan) End(string) {}

type spanHandle struct {
	span trace.Span
	once sync.Once
}

func (h *spanHandle) Context() *model.TraceContext {
	context := h.span.SpanContext()
	flags := "00"
	if context.IsSampled() {
		flags = "01"
	}
	return &model.TraceContext{Traceparent: "00-" + context.TraceID().String() + "-" + context.SpanID().String() + "-" + flags}
}

func (h *spanHandle) End(outcome string) {
	h.once.Do(func() {
		if !outcomes[outcome] {
			outcome = "unknown"
		}
		h.span.SetAttributes(attribute.String("outcome", outcome))
		status := codes.Ok
		if outcome == "failed" || outcome == "error" || outcome == "unknown" || outcome == "rejected" {
			status = codes.Error
		}
		h.span.SetStatus(status, "")
		h.span.End()
	})
}
