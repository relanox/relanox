package core

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/model"
)

func (s *scopedAgent) SendMessage(ctx context.Context, input model.SendMessageInput) (model.MessageReceipt, error) {
	if !s.runtime.accepting.Load() {
		return model.MessageReceipt{}, failure("not_accepting")
	}
	if !validID(input.Channel, 1024) || input.IdempotencyKey != "" && !validID(input.IdempotencyKey, 1024) {
		return model.MessageReceipt{}, failure("invalid_message_identity")
	}
	if err := validText(input.Text, len(input.Attachments) > 0); err != nil {
		return model.MessageReceipt{}, err
	}
	if input.Reply != nil && (!validID(input.Reply.RequestID, 1024) || input.Reply.Kind != model.Progress && input.Reply.Kind != model.Final) {
		return model.MessageReceipt{}, failure("invalid_reply_reference")
	}
	conversation, err := s.authorized(ctx, input.Channel)
	if err != nil {
		return model.MessageReceipt{}, err
	}
	if conversation == nil {
		return model.MessageReceipt{Status: model.NotFound}, nil
	}
	if input.Reply != nil {
		conversation, err = s.replyConversation(ctx, *conversation, input.Reply.RequestID)
		if err != nil {
			return model.MessageReceipt{}, err
		}
		if conversation == nil {
			return model.MessageReceipt{Status: model.NotFound}, nil
		}
	}
	return s.enqueue(ctx, input, *conversation)
}

func (s *scopedAgent) replyConversation(ctx context.Context, conv model.ConversationRecord, id string) (*model.ConversationRecord, error) {
	record, err := s.runtime.store.GetInbound(ctx, id)
	if err != nil || record == nil {
		return nil, err
	}
	if isFiltered(*record) || needsPreparation(*record) || !equal(record.Snapshot.Channel, conv.Address) || !equal(record.Snapshot.Endpoint, conv.Endpoint) {
		return nil, nil
	}
	conv.Target = &record.Snapshot.Target
	return &conv, nil
}

func (s *scopedAgent) enqueue(ctx context.Context, input model.SendMessageInput, conversation model.ConversationRecord) (model.MessageReceipt, error) {
	key := input.IdempotencyKey
	if key == "" {
		key = uuid.NewString()
	}
	recovery := input.IdempotencyKey != "" || input.Reply != nil && input.Reply.Kind == model.Final
	intent := key
	if input.Reply != nil && input.Reply.Kind == model.Final {
		intent = fingerprint([]string{"final", input.Reply.RequestID})
	}
	rich, err := planMessage(input.Text, input.Attachments)
	if err != nil {
		return model.MessageReceipt{}, err
	}
	prepared, err := prepareMedia(ctx, s.runtime.store, input.Channel, intent, rich.attachments, s.runtime.cfg.Media, recovery)
	if err != nil {
		return model.MessageReceipt{}, err
	}
	refs, err := orderedReferences(rich, prepared.references)
	if err != nil {
		return model.MessageReceipt{}, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	message := model.OutboundMessage{MessageID: key, Text: input.Text, Attachments: refs, Reply: input.Reply, CreatedAt: now}
	if recovery {
		receipt, err := s.runtime.store.GetMessageReceipt(ctx, model.MessageReceiptInput{ChannelID: input.Channel, EndpointIDs: s.principal.EndpointIDs, Agent: s.kind, Message: message})
		if err != nil || receipt.Status != model.NotFound {
			return receipt, err
		}
	}
	assets, err := completeMedia(ctx, s.runtime.store, input.Channel, prepared, s.runtime.cfg.Media)
	if err != nil {
		return model.MessageReceipt{}, err
	}
	return s.enqueuePlan(ctx, input, conversation, rich, prepared.references, message, assets, now)
}

func (s *scopedAgent) enqueuePlan(ctx context.Context, input model.SendMessageInput, conversation model.ConversationRecord, rich richMessage, refs []model.MediaReference, message model.OutboundMessage, assets []model.StoredMedia, now time.Time) (model.MessageReceipt, error) {
	channel := s.runtime.channel(conversation.Address.AccountID)
	if channel == nil {
		return model.MessageReceipt{}, failure("channel_missing")
	}
	resolution, err := channel.Resolve(ctx, conversation.Address, conversation.Target)
	if err != nil {
		return model.MessageReceipt{}, err
	}
	if !resolution.Available || resolution.Target == nil {
		return model.MessageReceipt{}, failure("channel_unavailable")
	}
	if !targetMatches(*resolution.Target, conversation.Address) {
		return model.MessageReceipt{}, failure("channel_target_scope_mismatch")
	}
	deliveryID := uuid.NewString()
	parent, err := s.replyTrace(ctx, input.Reply)
	if err != nil {
		return model.MessageReceipt{}, err
	}
	ctx, span := s.runtime.observe.Span(ctx, "enqueue_message", model.LogFields{Component: "core", Operation: "enqueue_message", ChannelID: input.Channel, DeliveryID: deliveryID}, parent)
	outcome := "failed"
	defer func() { span.End(outcome) }()
	chunks, err := deliveryPlan(channel, deliveryID, rich, refs, *resolution.Target)
	if err != nil {
		return model.MessageReceipt{}, err
	}
	limits := s.runtime.cfg.Media
	limits.MaxAttachments *= 2
	result, err := s.runtime.store.EnqueueMessage(ctx, model.EnqueueMessageInput{ChannelID: input.Channel, EndpointIDs: s.principal.EndpointIDs, Agent: s.kind, Message: message, Media: assets, Limits: limits, Outbound: model.OutboundRecord{DeliveryID: deliveryID, ChannelID: input.Channel, Endpoint: conversation.Endpoint, MessageID: message.MessageID, Target: *resolution.Target, Reply: input.Reply, Chunks: chunks, Status: model.DeliveryPending, Version: 1, DueAt: now, CreatedAt: now, Trace: span.Context()}})
	if err == nil {
		outcome = string(result.Status)
		s.runtime.observe.Log(ctx, "info", "message.queued", model.LogFields{Component: "core", ChannelID: input.Channel, DeliveryID: result.DeliveryID, Outcome: string(result.Status)})
	}
	if err == nil && result.Status != model.Queued && result.Status != model.NotFound && result.Status != model.Unauthorized && result.Status != model.Conflict {
		return model.MessageReceipt{}, failure(string(result.Status))
	}
	return result, err
}

func (s *scopedAgent) replyTrace(ctx context.Context, reply *model.ReplyReference) (*model.TraceContext, error) {
	if reply == nil {
		return nil, nil
	}
	record, err := s.runtime.store.GetInbound(ctx, reply.RequestID)
	if err != nil || record == nil {
		return nil, err
	}
	return record.Snapshot.Trace, nil
}

func targetMatches(target model.ReplyTarget, address model.ChannelAddress) bool {
	return target.Channel == address.Platform && target.AccountID == address.AccountID && target.ChatID == address.ChatID && target.ThreadID == address.ThreadID
}
