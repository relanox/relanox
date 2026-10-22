package cli

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// Cleanup must interpret the requested instant without UnixNano overflow. The
// 1670 cutoff previously wrapped into 2254 and erased current completed content.
// Existing CLI tests cover status/requeue, and storage tests pass in-range times
// directly, so neither covers this destructive flag-to-storage conversion. These
// tests run the actual CLI and reopen real SQLite state, without a fake store.
func TestCleanupCutoffKeepsLiteralNanosecondBounds(t *testing.T) {
	for _, row := range []struct {
		name, value       string
		invalid, redacted bool
	}{
		{"minimum", "1677-09-21T00:12:43.145224192Z", false, false},
		{"below-minimum", "1677-09-21T00:12:43.145224191Z", true, false},
		{"old-overflow", "1670-01-01T00:00:00Z", true, false},
		{"maximum", "2262-04-11T23:47:16.854775807Z", false, true},
		{"above-maximum", "2262-04-11T23:47:16.854775808Z", true, false},
		{"future-overflow", "9999-12-31T23:59:59Z", true, false},
		{"maximum-milliseconds", "9223372036854", false, true},
		{"above-maximum-milliseconds", "9223372036855", true, false},
		{"integer-overflow-range", "9223372036854775807", true, false},
	} {
		t.Run(row.name, func(t *testing.T) {
			path := completedCleanupFixture(t)
			out, err := execute(t, "", "--config", path, "cleanup", "--before", row.value, "--json")
			record := readCleanupRecord(t, path)
			if row.invalid {
				if err == nil || err.Error() != "invalid_cleanup_bounds" {
					t.Fatalf("invalid cutoff returned %v, output=%s, redacted=%v text=%q", err, out, record.RedactedAt != nil, record.Snapshot.Text)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if (record.RedactedAt != nil) != row.redacted {
				t.Fatalf("redacted=%v expected=%v", record.RedactedAt != nil, row.redacted)
			}
			if row.redacted {
				if record.Snapshot.Text != "" || !strings.Contains(out, `"removed":1`) {
					t.Fatalf("valid cleanup failed: record=%+v output=%s", record, out)
				}
			} else if record.Snapshot.Text != "private message body" {
				t.Fatal("cutoff changed protected content")
			}
		})
	}
}

// Argument rejection must precede config/storage access. A nonexistent config
// makes a later validation check return the wrong error without a mock seam.
func TestCleanupRejectsOverflowBeforeLoadingConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.json")
	for _, cutoff := range []string{"1670-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "9223372036855", "9223372036854775807"} {
		if _, err := execute(t, "", "--config", path, "cleanup", "--before", cutoff); err == nil || err.Error() != "invalid_cleanup_bounds" {
			t.Errorf("cutoff %s reached configuration: %v", cutoff, err)
		}
	}
}

func completedCleanupFixture(t *testing.T) string {
	t.Helper()
	path, version := adminFixture(t)
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store, err := storage.OpenExisting(ctx, cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	}()
	now := time.Now()
	result, err := store.Requeue(ctx, model.RequeueInput{Kind: model.DispatchWork, ID: "request-private", ExpectedVersion: version, AcknowledgeUnknown: true, Now: now})
	if err != nil || result.Status != model.Updated {
		t.Fatalf("requeue=%+v %v", result, err)
	}
	work, err := store.TakeDue(ctx, model.TakeDueInput{Now: now, LeaseOwner: "cleanup-test", Limit: 1, LeaseDuration: time.Minute, SendLeaseDuration: time.Minute, PreferredKind: model.DispatchWork})
	if err != nil || len(work) != 1 {
		t.Fatalf("claim=%v %v", work, err)
	}
	settled, err := store.SettleAttempt(ctx, model.Settlement{Kind: model.DispatchWork, ID: "request-private", Lease: work[0].Lease, Now: now, Dispatch: &model.DispatchResult{Status: model.Accepted}})
	if err != nil || settled.Status != model.Updated {
		t.Fatalf("settled=%+v %v", settled, err)
	}
	return path
}

func readCleanupRecord(t *testing.T, path string) *model.InboundRecord {
	t.Helper()
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.OpenExisting(context.Background(), cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	}()
	record, err := store.GetInbound(context.Background(), "request-private")
	if err != nil || record == nil {
		t.Fatalf("record=%v %v", record, err)
	}
	return record
}
