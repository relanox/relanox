package model

import (
	"testing"
	"time"
)

// Administration can inspect retained/redacted records hidden from normal agent
// reads. Shared reply projection must preserve precedence and unknown finals;
// existing successful native delivery tests did not cover these hidden records.
func TestRequestReplyStatusPreservesRetentionAndFinalOutcome(t *testing.T) {
	redacted := time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name     string
		record   InboundRecord
		delivery *OutboundRecord
		want     ReplyStatus
	}{
		{name: "awaiting", want: ReplyStatus{Status: AwaitingFinal}},
		{name: "expired", record: InboundRecord{RedactedAt: &redacted}, want: ReplyStatus{Status: Expired}},
		{name: "retained missing final", record: InboundRecord{RedactedAt: &redacted, FinalDeliveryID: "final"}, want: ReplyStatus{Status: Unknown, DeliveryID: "final"}},
		{name: "pending final", record: InboundRecord{FinalDeliveryID: "final"}, delivery: &OutboundRecord{DeliveryID: "final", Status: DeliveryPending}, want: ReplyStatus{Status: Pending, DeliveryID: "final"}},
		{name: "uncertain final", record: InboundRecord{FinalDeliveryID: "final"}, delivery: &OutboundRecord{DeliveryID: "final", Status: DeliveryUnknown, ErrorCode: "lease_expired"}, want: ReplyStatus{Status: Unknown, DeliveryID: "final", ErrorCode: "lease_expired"}},
		{name: "filtered after retention", record: InboundRecord{RedactedAt: &redacted, Dispatch: AttemptState{Status: AttemptRejected, ErrorCode: "middleware_filtered"}}, want: ReplyStatus{Status: Rejected, ErrorCode: "middleware_filtered"}},
		{name: "prepared filter", record: InboundRecord{Preparation: []PreparationResult{{Status: "completed", Output: &PreparationOutput{Filtered: true}}}}, want: ReplyStatus{Status: Rejected, ErrorCode: "middleware_filtered"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := RequestReplyStatus(test.record, test.delivery); got != test.want {
				t.Fatalf("reply=%#v want=%#v", got, test.want)
			}
		})
	}
}
