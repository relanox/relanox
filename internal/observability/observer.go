// Package observability provides bounded structured operational logs, a private
// Prometheus registry and an instance-local OTLP tracing provider.
package observability

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type Options struct{ Writer io.Writer }

type Observer struct {
	cfg        config.Observability
	registry   *prometheus.Registry
	dropped    *prometheus.CounterVec
	counters   map[string]*prometheus.CounterVec
	histograms map[string]*prometheus.HistogramVec
	gauges     map[string]*prometheus.GaugeVec
	series     map[string]map[string]bool
	metricMu   sync.Mutex
	metrics    http.Handler
	provider   *sdktrace.TracerProvider
	tracer     trace.Tracer
	writer     io.Writer
	logs       chan []byte
	logMu      sync.RWMutex
	logDone    chan struct{}
	closed     atomic.Bool
	closeOnce  sync.Once
	closeDone  chan struct{}
	closeErr   error
}

var _ model.Observer = (*Observer)(nil)

func New(cfg config.Observability, options Options) (*Observer, error) {
	if cfg.Level == "" {
		cfg.Level = "info"
	}
	if err := config.ValidateObservability(cfg); err != nil {
		return nil, err
	}
	if options.Writer == nil {
		options.Writer = os.Stderr
	}
	o := &Observer{cfg: cfg, writer: options.Writer, logs: make(chan []byte, 128), logDone: make(chan struct{}), closeDone: make(chan struct{})}
	o.initMetrics()
	if err := o.initTracing(); err != nil {
		return nil, err
	}
	go o.writeLogs()
	return o, nil
}

var levels = map[string]int{"debug": 0, "info": 1, "warn": 2, "error": 3}

func (o *Observer) Log(ctx context.Context, level, event string, fields model.LogFields) {
	if o.closed.Load() {
		return
	}
	priority, known := levels[level]
	if !known || priority < levels[o.cfg.Level] {
		return
	}
	if !events[event] {
		event = "operation.failed"
	}
	if current := trace.SpanContextFromContext(ctx); current.IsValid() {
		fields.TraceID = current.TraceID().String()
	}
	line := safeFields(fields)
	line["time"], line["level"], line["event"] = time.Now().UTC().Format(time.RFC3339Nano), level, event
	data, err := json.Marshal(line)
	if err != nil {
		o.drop("logs")
		return
	}
	o.logMu.RLock()
	defer o.logMu.RUnlock()
	if o.closed.Load() {
		return
	}
	select {
	case o.logs <- append(data, '\n'):
	default:
		o.drop("logs")
	}
}

func (o *Observer) writeLogs() {
	defer close(o.logDone)
	for line := range o.logs {
		if err := writeLine(o.writer, line); err != nil {
			o.drop("logs")
		}
	}
}

func writeLine(writer io.Writer, line []byte) (err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("log_destination_failed")
		}
	}()
	written, err := writer.Write(line)
	if err == nil && written != len(line) {
		return io.ErrShortWrite
	}
	return err
}

func (o *Observer) Close(ctx context.Context) error {
	o.closeOnce.Do(func() {
		o.closed.Store(true)
		o.logMu.Lock()
		close(o.logs)
		o.logMu.Unlock()
		go o.finish(ctx)
	})
	select {
	case <-o.closeDone:
		return o.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (o *Observer) finish(ctx context.Context) {
	defer close(o.closeDone)
	if o.provider != nil {
		if err := o.provider.Shutdown(ctx); err != nil {
			o.closeErr = errors.New("tracing_shutdown_failed")
		}
	}
	select {
	case <-o.logDone:
	case <-ctx.Done():
		o.closeErr = errors.Join(o.closeErr, ctx.Err())
	}
}
