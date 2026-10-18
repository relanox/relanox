package core

import (
	"testing"
	"time"

	"github.com/relanox/relanox/internal/model"
)

// Native worker coverage proves 48-hour receipts reach settlement, but cannot
// wait through nine retries or the end of the signed-nanosecond storage range.
// These fixed policy boundaries exercise the same production deadline planner
// without changing clocks, persistence, or introducing a test-only interface.
func TestRetryDeadlineBoundaries(t *testing.T) {
	now := time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name     string
		attempts int
		delay    time.Duration
		want     time.Time
	}{
		{name: "exponential below cap", attempts: 8, want: time.Date(2026, 10, 18, 0, 4, 16, 0, time.UTC)},
		{name: "exponential cap", attempts: 9, want: time.Date(2026, 10, 18, 0, 5, 0, 0, time.UTC)},
		{name: "storage range", delay: time.Duration(1<<63 - 1), want: time.Date(2262, 4, 11, 23, 47, 16, 854775807, time.UTC)},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := &Runtime{}
			settlement := model.Settlement{Send: &model.SendResult{Status: model.Retryable, RetryAfter: test.delay}}
			work := model.DueWork{Outbound: &model.OutboundRecord{Attempts: test.attempts}}
			if got := r.nextDue(settlement, work, now); !got.Equal(test.want) {
				t.Fatalf("deadline=%s want=%s", got, test.want)
			}
		})
	}
}
