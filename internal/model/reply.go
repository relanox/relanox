package model

// RequestReplyStatus projects the durable final reply without exposing its
// private native target. A missing referenced delivery has an unknown outcome.
func RequestReplyStatus(record InboundRecord, delivery *OutboundRecord) ReplyStatus {
	if requestFiltered(record) {
		return ReplyStatus{Status: Rejected, ErrorCode: "middleware_filtered"}
	}
	if record.FinalDeliveryID != "" {
		if delivery == nil {
			return ReplyStatus{Status: Unknown, DeliveryID: record.FinalDeliveryID}
		}
		return ReplyStatus{Status: Outcome(delivery.Status), DeliveryID: delivery.DeliveryID, ErrorCode: delivery.ErrorCode}
	}
	if record.RedactedAt != nil {
		return ReplyStatus{Status: Expired}
	}
	return ReplyStatus{Status: AwaitingFinal}
}

func requestFiltered(record InboundRecord) bool {
	if record.Dispatch.ErrorCode == "middleware_filtered" {
		return true
	}
	for _, result := range record.Preparation {
		if result.Status == "completed" && result.Output != nil && result.Output.Filtered {
			return true
		}
	}
	return false
}
