package mattermost

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
)

// Recovery includes a real reconnect backoff, several Core/SQLite accepts and
// the final native checkpoint. These are outcome tests rather than latency
// tests. A fixed 30-second budget includes reads and leaves cleanup time before
// go test's deadline; 50ms polling yields SQLite's single connection to writers.
func awaitNativeState(t *testing.T, f *fixture, description string, matches func(cursor) bool) cursor {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	if testDeadline, ok := t.Deadline(); ok && testDeadline.Add(-5*time.Second).Before(deadline) {
		deadline = testDeadline.Add(-5 * time.Second)
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	var last cursor
	var version int64
	for {
		value, entry, err := common.ReadState[cursor](ctx, f.host.State(), "websocket-cursor")
		if err != nil {
			t.Fatalf("waiting for %s: %v; last checkpoint: version=%d %s", description, err, version, cursorDiagnostic(f, last))
		}
		last = value
		version = 0
		if entry != nil {
			version = entry.Version
		}
		if matches(value) {
			return value
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for %s: %v; last checkpoint: version=%d %s", description, ctx.Err(), version, cursorDiagnostic(f, last))
		case <-ticker.C:
		}
	}
}

func cursorDiagnostic(f *fixture, value cursor) string {
	var recovery []historyChannel
	if value.Recovery != nil {
		recovery = value.Recovery.Channels
	}
	return fmt.Sprintf("connection=%q sequence=%d watermarks=%v recovering=%t recovery=%+v connections=%v historyHTTPFailed=%d historyHTTPOK=%d active=%d", value.ConnectionID, value.NextSequence, value.Watermarks, value.Recovery != nil, recovery, f.runtime.Connections(), f.peer.historyFailures.Load(), f.peer.historySuccesses.Load(), f.peer.active.Load())
}
