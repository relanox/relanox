package storage_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/model"
)

// A representable long duration can exceed the database's absolute UnixNano
// range. Existing minute-long recovery fixtures cannot expose a wrapped expiry
// that immediately marks live work unknown. Real SQLite reopen and settlement
// check persistence and fencing without a clock or storage-only test seam.
func TestLongLeaseSaturatesPersistedExpiryAndRemainsLive(t *testing.T) {
	for _, kind := range []model.WorkKind{model.DispatchWork, model.SendWork} {
		t.Run(string(kind), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "lease.db")
			s := openStore(t, path)
			initialize(t, s)
			at := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
			if kind == model.DispatchWork {
				if _, err := s.AcceptInbound(ctx, snapshot("request", at), nil); err != nil {
					t.Fatal(err)
				}
			} else {
				result, err := s.EnqueueMessage(ctx, outboundInput("message", "delivery", at, nil))
				if err != nil || result.Status != model.Queued {
					t.Fatalf("enqueue: %+v %v", result, err)
				}
			}
			work, err := s.TakeDue(ctx, model.TakeDueInput{Now: at, LeaseDuration: 9223372036 * time.Second, LeaseOwner: "worker", Limit: 1})
			if err != nil || len(work) != 1 {
				t.Fatalf("claim: %+v %v", work, err)
			}
			maximum := time.Date(2262, 4, 11, 23, 47, 16, 854775807, time.UTC)
			if !work[0].Lease.ExpiresAt.Equal(maximum) {
				t.Fatalf("expiry outside persisted timestamp range: %s", work[0].Lease.ExpiresAt)
			}
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			s = openStore(t, path)
			if next := take(t, s, at.Add(time.Second), kind); len(next) != 0 {
				t.Fatalf("live lease was reclaimed: %+v", next)
			}
			outcome := model.Accepted
			if kind == model.SendWork {
				outcome = model.Sent
			}
			if result := settle(t, s, work[0], at.Add(time.Second), outcome); result.Status != model.Updated {
				t.Fatalf("live lease became expired or unknown: %+v", result)
			}
		})
	}
}
