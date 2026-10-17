package observability

import (
	"math"
	"net/http"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/relanox/relanox/internal/model"
)

var labelNames = []string{"channel", "agent", "component", "operation", "outcome", "error_class"}

var counterNames = strings.Fields("relanox_inbound_total relanox_discovered_conversations_total relanox_settlement_conflicts_total relanox_work_total relanox_dispatch_total relanox_delivery_total relanox_retries_total relanox_transcription_total")

var histogramNames = strings.Fields("relanox_preparation_duration_seconds relanox_transcription_duration_seconds relanox_http_duration_seconds relanox_storage_duration_seconds relanox_dispatch_duration_seconds relanox_send_duration_seconds relanox_delivery_duration_seconds")

var gaugeNames = strings.Fields("relanox_pending relanox_outbound relanox_unknown relanox_oldest_pending_age_seconds relanox_worker_last_success_timestamp_seconds relanox_connection_status relanox_storage_stats_stale")

func (o *Observer) initMetrics() {
	o.registry = prometheus.NewRegistry()
	o.dropped = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "relanox_telemetry_dropped_total", Help: "Telemetry records discarded by bounds, validation or unavailable destinations."}, []string{"signal"})
	o.registry.MustRegister(o.dropped)
	for _, signal := range []string{"logs", "metrics", "traces"} {
		o.dropped.WithLabelValues(signal)
	}
	o.counters = map[string]*prometheus.CounterVec{}
	o.histograms = map[string]*prometheus.HistogramVec{}
	o.gauges = map[string]*prometheus.GaugeVec{}
	o.series = map[string]map[string]bool{}
	for _, name := range counterNames {
		metric := prometheus.NewCounterVec(prometheus.CounterOpts{Name: name, Help: strings.ReplaceAll(name, "_", " ")}, labelNames)
		o.counters[name] = metric
		o.registry.MustRegister(metric)
	}
	for _, name := range histogramNames {
		metric := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: name, Help: strings.ReplaceAll(name, "_", " "), Buckets: []float64{0.005, 0.025, 0.1, 0.5, 1, 5, 30, 120, 600, 3600}}, labelNames)
		o.histograms[name] = metric
		o.registry.MustRegister(metric)
	}
	for _, name := range gaugeNames {
		metric := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: name, Help: strings.ReplaceAll(name, "_", " ")}, labelNames)
		o.gauges[name] = metric
		o.registry.MustRegister(metric)
	}
	if o.cfg.Metrics {
		o.registry.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	}
	o.metrics = promhttp.HandlerFor(o.registry, promhttp.HandlerOpts{MaxRequestsInFlight: 4})
}

func (o *Observer) labels(name string, labels model.MetricLabels) ([]string, bool) {
	values, ok := safeLabels(labels)
	if !ok {
		o.drop("metrics")
		return nil, false
	}
	key := strings.Join(values, "\x00")
	o.metricMu.Lock()
	defer o.metricMu.Unlock()
	if o.series[name] == nil {
		o.series[name] = map[string]bool{}
	}
	if !o.series[name][key] && len(o.series[name]) >= 64 {
		o.drop("metrics")
		return nil, false
	}
	o.series[name][key] = true
	return values, true
}

func (o *Observer) Count(name string, labels model.MetricLabels, value int64) {
	if o.closed.Load() || !o.cfg.Metrics {
		return
	}
	metric := o.counters[name]
	if metric == nil || value < 0 {
		o.drop("metrics")
		return
	}
	if labels, ok := o.labels(name, labels); ok {
		metric.WithLabelValues(labels...).Add(float64(value))
	}
}

func (o *Observer) Record(name string, value float64, labels model.MetricLabels) {
	if o.closed.Load() || !o.cfg.Metrics {
		return
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || o.histograms[name] == nil && o.gauges[name] == nil {
		o.drop("metrics")
		return
	}
	values, ok := o.labels(name, labels)
	if !ok {
		return
	}
	if histogram := o.histograms[name]; histogram != nil {
		histogram.WithLabelValues(values...).Observe(value)
	}
	if gauge := o.gauges[name]; gauge != nil {
		gauge.WithLabelValues(values...).Set(value)
	}
}

// Handler is mounted only by the private management server.
func (o *Observer) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !o.cfg.Metrics {
			http.NotFound(w, r)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			w.Header().Set("Allow", "GET, HEAD")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		o.metrics.ServeHTTP(w, r)
	})
}

func (o *Observer) drop(signal string) { o.dropped.WithLabelValues(signal).Inc() }
