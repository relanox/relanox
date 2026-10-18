package observability_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/observability"
)

// Both logs and metrics identify the same finite native components. Existing
// diagnostic tests focus on error codes and expected the newer component field;
// they missed collectors losing their established plugin correlation field.
func TestOperationalLogsUseBoundedPluginNames(t *testing.T) {
	rows := []struct{ component, plugin string }{
		{"core", "core"},
		{"cli", "cli"},
		{"channel:telegram", "channel-telegram"},
		{"agent:grok", "agent-grok"},
		{"storage:sqlite", "storage-sqlite"},
		{"storage:postgres", "storage-postgres"},
		{"speech-tencent", "speech-tencent"},
		{"observability", "observability-standard"},
		{"private-token-component", ""},
	}
	var output bytes.Buffer
	observer, err := observability.New(config.Observability{}, observability.Options{Writer: &output})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		observer.Log(context.Background(), "info", "operation.failed", model.LogFields{Component: row.component})
	}
	closeObserver(t, observer)
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != len(rows) {
		t.Fatalf("lost operational log records: %d", len(lines))
	}
	for i, line := range lines {
		var entry map[string]string
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		if entry["plugin"] != rows[i].plugin || entry["component"] != "" || strings.Contains(line, "private-token") {
			t.Errorf("unrecognizable or unsafe log plugin field: %s", line)
		}
	}
}

// Disabling operational logs must leave explicitly enabled metrics available.
// Existing Writer/level tests never disabled logs independently, so an observer
// ignoring the option would still pass them. Both outputs use production sinks.
func TestOperationalLogsCanBeDisabledWithoutDisablingMetrics(t *testing.T) {
	disabled := false
	var output bytes.Buffer
	observer, err := observability.New(config.Observability{Logs: &disabled, Metrics: true}, observability.Options{Writer: &output})
	if err != nil {
		t.Fatal(err)
	}
	observer.Log(context.Background(), "error", "operation.failed", model.LogFields{Component: "core"})
	observer.Count("relanox_inbound_total", model.MetricLabels{Component: "core"}, 1)
	closeObserver(t, observer)
	if output.Len() != 0 {
		t.Fatalf("disabled operational log was written: %s", output.String())
	}
	if !strings.Contains(scrape(t, observer), `relanox_inbound_total{agent="",channel="",error_class="",operation="",outcome="",plugin="core"} 1`) {
		t.Fatal("disabling logs also disabled explicitly enabled metrics")
	}
}

// The default destination is a public collector contract. Explicit Writer tests
// cannot detect a constructor silently redirecting operational logs to stderr.
// Real OS pipes exercise the default sink without adding an observer test seam.
func TestDefaultOperationalLogDestinationIsStdout(t *testing.T) {
	stdout, stderr := os.Stdout, os.Stderr
	outputRead, outputWrite := pipe(t)
	errorRead, errorWrite := pipe(t)
	os.Stdout, os.Stderr = outputWrite, errorWrite
	defer func() { os.Stdout, os.Stderr = stdout, stderr }()
	observer, err := observability.New(config.Observability{}, observability.Options{})
	if err != nil {
		t.Fatal(err)
	}
	observer.Log(context.Background(), "info", "startup.completed", model.LogFields{Component: "cli"})
	closeObserver(t, observer)
	if err := outputWrite.Close(); err != nil {
		t.Fatal(err)
	}
	if err := errorWrite.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(outputRead)
	if err != nil {
		t.Fatal(err)
	}
	diagnostics, err := io.ReadAll(errorRead)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), `"event":"startup.completed"`) || len(diagnostics) != 0 {
		t.Fatalf("operational logs did not reach stdout: stdout=%s stderr=%s", output, diagnostics)
	}
}

func pipe(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := writer.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			t.Error(err)
		}
		if err := reader.Close(); err != nil {
			t.Error(err)
		}
	})
	return reader, writer
}

// Prometheus consumers need stable plugin labels even though the application
// statically composes components. Existing tests expected component labels and
// did not check the preparation counter or the registered worker gauge outputs.
func TestPrometheusPreservesOperationalNamesAndPluginLabels(t *testing.T) {
	observer, err := observability.New(config.Observability{Metrics: true}, observability.Options{Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer closeObserver(t, observer)
	for _, component := range []string{"core", "cli", "channel:telegram", "agent:grok", "storage:sqlite", "storage:postgres", "speech-tencent", "observability"} {
		observer.Count("relanox_inbound_total", model.MetricLabels{Component: component}, 1)
	}
	observer.Count("relanox_middleware_total", model.MetricLabels{Outcome: "completed"}, 2)
	observer.Record("relanox_oldest_pending_age_seconds", 7, model.MetricLabels{})
	observer.Record("relanox_worker_last_success_timestamp_seconds", 1700000000, model.MetricLabels{})
	observer.Record("relanox_storage_stats_stale", 1, model.MetricLabels{})
	metrics := scrape(t, observer)
	for _, plugin := range []string{"core", "cli", "channel-telegram", "agent-grok", "storage-sqlite", "storage-postgres", "speech-tencent", "observability-standard"} {
		if !strings.Contains(metrics, `plugin="`+plugin+`"`) {
			t.Errorf("missing bounded plugin label %q", plugin)
		}
	}
	for _, line := range []string{
		`relanox_middleware_total{agent="",channel="",error_class="",operation="",outcome="completed",plugin=""} 2`,
		`relanox_oldest_pending_age_seconds{agent="",channel="",error_class="",operation="",outcome="",plugin=""} 7`,
		`relanox_worker_last_success_timestamp_seconds{agent="",channel="",error_class="",operation="",outcome="",plugin=""} 1.7e+09`,
		`relanox_storage_stats_stale{agent="",channel="",error_class="",operation="",outcome="",plugin=""} 1`,
	} {
		if !strings.Contains(metrics, line) {
			t.Errorf("missing operational metric %s", line)
		}
	}
	if strings.Contains(metrics, "component=") {
		t.Error("component label replaced the public plugin label")
	}
}
