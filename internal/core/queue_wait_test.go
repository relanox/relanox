package core_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// These composition tests assert durable outcomes, not five-second latency.
// Windows under concurrent real SQLite load can take longer to commit several
// chunks or preparation/dispatch transactions. Thirty seconds covers those
// steps while remaining below the default 60-second inbound lease. Keep one
// fixed budget, including reads, and leave time for cleanup before go test ends.
// Polling every 50ms yields SQLite's single connection to the actual worker.
func waitForQueue(t *testing.T, description string, inspect func(context.Context) (bool, string, error)) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	if testDeadline, ok := t.Deadline(); ok && testDeadline.Add(-5*time.Second).Before(deadline) {
		deadline = testDeadline.Add(-5 * time.Second)
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	last := "not inspected"
	for {
		done, detail, err := inspect(ctx)
		if err != nil {
			t.Fatalf("waiting for %s: %v; last observed: %s; current: %s", description, err, last, detail)
		}
		last = detail
		if done {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for %s: %v; last observed: %s", description, ctx.Err(), last)
		case <-ticker.C:
		}
	}
}

func awaitInboundRecord(t *testing.T, store *storage.Store, id string, status model.AttemptStatus) *model.InboundRecord {
	t.Helper()
	var result *model.InboundRecord
	waitForQueue(t, "durable inbound "+id+" to reach "+string(status), func(ctx context.Context) (bool, string, error) {
		records, err := inspectInbounds(ctx, store, id)
		if err != nil {
			return false, "read failed", err
		}
		if len(records) == 0 {
			return false, "inbound absent", nil
		}
		var details []string
		for _, record := range records {
			if record.Dispatch.Status == status {
				result = &record
				return true, inboundProgress(record), nil
			}
			details = append(details, inboundProgress(record))
		}
		for _, record := range records {
			if record.Dispatch.Status != model.AttemptDue {
				return false, strings.Join(details, "; "), fmt.Errorf("unexpected terminal dispatch status %s", record.Dispatch.Status)
			}
		}
		return false, strings.Join(details, "; "), nil
	})
	return result
}

func inspectInbounds(ctx context.Context, store *storage.Store, id string) ([]model.InboundRecord, error) {
	if id == "" {
		return store.ListInbound(ctx, model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 20}})
	}
	record, err := store.GetInbound(ctx, id)
	if err != nil || record == nil {
		return nil, err
	}
	return []model.InboundRecord{*record}, nil
}

func inboundProgress(record model.InboundRecord) string {
	var prepared []string
	for _, preparation := range record.Preparation {
		prepared = append(prepared, preparation.ID+":"+preparation.Status+":"+preparation.ErrorCode)
	}
	return fmt.Sprintf("request=%s status=%s version=%d attempts=%d error=%q lease=%v preparation=%v", record.Snapshot.RequestID, record.Dispatch.Status, record.Version, record.Dispatch.Attempts, record.Dispatch.ErrorCode, record.Dispatch.Lease, prepared)
}
