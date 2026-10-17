package storage

import (
	"context"
	"errors"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage/ent"
	"github.com/relanox/relanox/internal/storage/ent/conversation"
	"github.com/relanox/relanox/internal/storage/ent/inbound"
	"github.com/relanox/relanox/internal/storage/ent/outbound"
)

func (s *Store) AcceptInbound(ctx context.Context, snapshot model.InboundSnapshot, assets []model.StoredMedia) (model.IngestReceipt, error) {
	var receipt model.IngestReceipt
	err := s.write(ctx, func(tx *ent.Tx) error {
		previous, err := tx.Inbound.Query().Where(inbound.ChannelEQ(string(snapshot.Source.Channel)), inbound.AccountIDEQ(snapshot.Source.AccountID), inbound.EventIDEQ(snapshot.Source.EventID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return err
		}
		if previous != nil {
			receipt = model.IngestReceipt{RequestID: previous.ID, Duplicate: true}
			return nil
		}
		if snapshot.RequestID == "" || snapshot.Source.EventID == "" {
			return errors.New("inbound_identity_invalid")
		}
		row, err := tx.Conversation.Query().Where(conversation.IDEQ(snapshot.Channel.ID), conversation.Active(true)).Only(ctx)
		if ent.IsNotFound(err) {
			return errors.New("unauthorized_inbound_conversation")
		}
		if err != nil {
			return err
		}
		if !validInbound(snapshot, row.Record) {
			return errors.New("unauthorized_inbound_conversation")
		}
		ids, err := incomingMedia(ctx, tx, snapshot, assets)
		if err != nil {
			return err
		}
		record := model.InboundRecord{Snapshot: snapshot, Version: 1, Dispatch: model.AttemptState{Status: model.AttemptDue, DueAt: snapshot.AcceptedAt}}
		if err = tx.Inbound.Create().SetID(snapshot.RequestID).SetChannel(string(snapshot.Source.Channel)).SetAccountID(snapshot.Source.AccountID).SetEventID(snapshot.Source.EventID).SetChannelID(snapshot.Channel.ID).SetEndpointID(snapshot.Endpoint.ID).SetAcceptedAt(snapshot.AcceptedAt.UnixNano()).SetStatus(string(record.Dispatch.Status)).SetVersion(1).SetDueAt(snapshot.AcceptedAt.UnixNano()).SetReady(!needsPreparation(record)).SetFiltered(false).SetRedacted(false).SetFinalDeliveryID("").SetRecord(record).AddAssetIDs(ids...).Exec(ctx); err != nil {
			return err
		}
		conv := row.Record
		conv.Target = &snapshot.Target
		if err = tx.Conversation.UpdateOneID(row.ID).SetRecord(conv).Exec(ctx); err != nil {
			return err
		}
		receipt = model.IngestReceipt{RequestID: snapshot.RequestID}
		return nil
	})
	return receipt, err
}

func validInbound(snapshot model.InboundSnapshot, conversation model.ConversationRecord) bool {
	return equal(snapshot.Channel, conversation.Address) && equal(snapshot.Endpoint, conversation.Endpoint) && targetMatches(snapshot.Target, conversation.Address) && snapshot.Source.Channel == conversation.Address.Platform && snapshot.Source.AccountID == conversation.Address.AccountID
}

func resolveReply(ctx context.Context, tx *ent.Tx, conv model.ConversationRecord, message model.OutboundMessage) (*model.InboundRecord, bool, error) {
	if message.Reply == nil {
		return nil, true, nil
	}
	if message.Reply.Kind != model.Progress && message.Reply.Kind != model.Final {
		return nil, false, nil
	}
	row, err := tx.Inbound.Get(ctx, message.Reply.RequestID)
	if ent.IsNotFound(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	record := row.Record
	return &record, !needsPreparation(record) && !filtered(record) && validInbound(record.Snapshot, conv), nil
}

func previousReceipt(ctx context.Context, tx *ent.Tx, channelID string, message model.OutboundMessage, source *model.InboundRecord) (model.MessageReceipt, error) {
	q := tx.Outbound.Query()
	if message.Reply != nil && message.Reply.Kind == model.Final && source != nil && source.FinalDeliveryID != "" {
		q.Where(outbound.IDEQ(source.FinalDeliveryID))
	} else {
		q.Where(outbound.ChannelIDEQ(channelID), outbound.MessageIDEQ(message.MessageID))
	}
	row, err := q.Select(outbound.FieldID, outbound.FieldDigest).Only(ctx)
	if ent.IsNotFound(err) {
		return model.MessageReceipt{Status: model.NotFound}, nil
	}
	if err != nil {
		return model.MessageReceipt{}, err
	}
	if row.Digest != messageDigest(message) {
		return model.MessageReceipt{Status: model.Conflict}, nil
	}
	return model.MessageReceipt{Status: model.Queued, DeliveryID: row.ID, Replay: true}, nil
}

func (s *Store) GetMessageReceipt(ctx context.Context, input model.MessageReceiptInput) (model.MessageReceipt, error) {
	result := model.MessageReceipt{Status: model.NotFound}
	err := s.write(ctx, func(tx *ent.Tx) error {
		result = model.MessageReceipt{Status: model.NotFound}
		conv, err := scopedConversation(ctx, tx, input.ChannelID, input.Agent, input.EndpointIDs)
		if err != nil || conv == nil {
			return err
		}
		source, valid, err := resolveReply(ctx, tx, *conv, input.Message)
		if err != nil || !valid {
			return err
		}
		result, err = previousReceipt(ctx, tx, input.ChannelID, input.Message, source)
		return err
	})
	return result, err
}

func (s *Store) EnqueueMessage(ctx context.Context, input model.EnqueueMessageInput) (model.MessageReceipt, error) {
	result := model.MessageReceipt{Status: model.NotFound}
	err := s.write(ctx, func(tx *ent.Tx) error {
		result = model.MessageReceipt{Status: model.NotFound}
		conv, err := tx.Conversation.Query().Where(conversation.IDEQ(input.ChannelID), conversation.Active(true)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !inScope(conv.Record, input.Agent, input.EndpointIDs) {
			result.Status = model.Unauthorized
			return nil
		}
		source, valid, err := resolveReply(ctx, tx, conv.Record, input.Message)
		if err != nil || !valid {
			return err
		}
		result, err = previousReceipt(ctx, tx, input.ChannelID, input.Message, source)
		if err != nil || result.Status != model.NotFound {
			return err
		}
		if source != nil && source.RedactedAt != nil {
			return nil
		}
		return enqueueNew(ctx, tx, input, conv.Record, source, &result)
	})
	return result, err
}

func enqueueNew(ctx context.Context, tx *ent.Tx, input model.EnqueueMessageInput, conv model.ConversationRecord, source *model.InboundRecord, result *model.MessageReceipt) error {
	result.Status = model.Conflict
	if !matchesInitial(input, conv) {
		return nil
	}
	exists, err := tx.Outbound.Query().Where(outbound.IDEQ(input.Outbound.DeliveryID)).Exist(ctx)
	if err != nil || exists {
		return err
	}
	ids, status, err := resolveMessageMedia(ctx, tx, input)
	if err != nil {
		return err
	}
	if status != model.Stored {
		result.Status = status
		return nil
	}
	record := input.Outbound
	if err = tx.Outbound.Create().SetID(record.DeliveryID).SetChannel(string(record.Target.Channel)).SetChannelID(record.ChannelID).SetAccountID(record.Target.AccountID).SetEndpointID(record.Endpoint.ID).SetMessageID(record.MessageID).SetDigest(messageDigest(input.Message)).SetCreatedAt(record.CreatedAt.UnixNano()).SetStatus(string(record.Status)).SetVersion(record.Version).SetDueAt(record.DueAt.UnixNano()).SetRedacted(false).SetRecord(record).AddAssetIDs(ids...).Exec(ctx); err != nil {
		return err
	}
	if source != nil && input.Message.Reply.Kind == model.Final {
		source.FinalDeliveryID = record.DeliveryID
		source.Version++
		if err = saveInbound(ctx, tx, *source); err != nil {
			return err
		}
	}
	*result = model.MessageReceipt{Status: model.Queued, DeliveryID: record.DeliveryID}
	return nil
}

func matchesInitial(input model.EnqueueMessageInput, conv model.ConversationRecord) bool {
	r := input.Outbound
	if r.DeliveryID == "" || r.MessageID == "" || r.ChannelID != input.ChannelID || r.MessageID != input.Message.MessageID || !equal(r.Reply, input.Message.Reply) || !r.CreatedAt.Equal(input.Message.CreatedAt) || !equal(r.Endpoint, conv.Endpoint) || !targetMatches(r.Target, conv.Address) {
		return false
	}
	if r.CurrentChunk != 0 || len(r.Receipts) != 0 || r.Status != model.DeliveryPending || r.Version != 1 || r.Attempts != 0 || r.Lease != nil || r.RedactedAt != nil || len(r.Chunks) == 0 {
		return false
	}
	var refs []model.MediaReference
	keys := map[string]bool{}
	for _, chunk := range r.Chunks {
		if !validChunk(chunk) || chunk.IdempotencyKey == "" || keys[chunk.IdempotencyKey] {
			return false
		}
		keys[chunk.IdempotencyKey] = true
		refs = append(refs, chunkMedia(chunk)...)
	}
	return equal(refs, input.Message.Attachments) || len(refs) == 0 && len(input.Message.Attachments) == 0
}

func chunkMedia(chunk model.DeliveryChunk) []model.MediaReference {
	if chunk.Media != nil {
		return []model.MediaReference{*chunk.Media}
	}
	var refs []model.MediaReference
	for _, part := range chunk.RichText {
		if part.Type == "image" && part.Media != nil {
			refs = append(refs, *part.Media)
		}
	}
	return refs
}

func validChunk(chunk model.DeliveryChunk) bool {
	if chunk.RichText == nil {
		return chunk.Media == nil || chunk.Text == ""
	}
	if chunk.Text != "" || chunk.Media != nil || len(chunk.RichText) == 0 {
		return false
	}
	hasImage := false
	for _, part := range chunk.RichText {
		if part.Type == "text" {
			if part.Text == "" || part.Media != nil {
				return false
			}
			continue
		}
		if part.Type != "image" || part.Media == nil || part.Media.Kind != model.Image {
			return false
		}
		hasImage = true
	}
	return hasImage
}
