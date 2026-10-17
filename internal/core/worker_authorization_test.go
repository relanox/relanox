package core_test

import (
	"testing"
	"time"

	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
)

// Accepted delivery ownership survives in storage, but a new native send must
// respect the current active binding. Existing scope tests cover enqueue/read,
// not a queued delivery after conversation registration revokes its binding.
// Real SQLite and the native WeChat HTTP peer exercise the worker without a seam.
func TestQueuedDeliveryRechecksActiveConversation(t *testing.T) {
	f := newRelayFixture(t, core.Options{})
	source := awaitInbound(t, f.store, model.AttemptAccepted)
	at := time.Now().UTC()
	input := model.EnqueueMessageInput{
		ChannelID: source.Snapshot.Channel.ID, EndpointIDs: []string{"grok"}, Agent: model.Grok,
		Message:  model.OutboundMessage{MessageID: "revoked", Text: "must stay private", CreatedAt: at},
		Outbound: model.OutboundRecord{DeliveryID: "revoked-delivery", ChannelID: source.Snapshot.Channel.ID, Endpoint: source.Snapshot.Endpoint, MessageID: "revoked", Target: source.Snapshot.Target, Chunks: []model.DeliveryChunk{{Text: "must stay private", IdempotencyKey: "revoked/0"}}, Status: model.DeliveryPending, Version: 1, DueAt: at.Add(2 * time.Second), CreatedAt: at},
	}
	receipt, err := f.store.EnqueueMessage(f.ctx, input)
	if err != nil || receipt.Status != model.Queued {
		t.Fatalf("queue: %#v %v", receipt, err)
	}
	// RegisterConversations is the same production operation used at restart.
	if err := f.store.RegisterConversations(f.ctx, nil); err != nil {
		t.Fatal(err)
	}
	awaitDelivery(t, f.store, receipt.DeliveryID, model.DeliveryRejected)
	record, err := f.store.GetOutbound(f.ctx, receipt.DeliveryID)
	if err != nil || record.ErrorCode != "unauthorized_conversation" || record.CurrentChunk != 0 {
		t.Fatalf("revoked delivery: %#v %v", record, err)
	}
	select {
	case sent := <-f.sends:
		t.Fatalf("revoked binding sent native message: %#v", sent)
	default:
	}
}
