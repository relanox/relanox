package storage

import (
	"context"
	"errors"
	"time"

	"entgo.io/ent/dialect/sql"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage/ent"
	"github.com/relanox/relanox/internal/storage/ent/conversation"
	"github.com/relanox/relanox/internal/storage/ent/inbound"
	"github.com/relanox/relanox/internal/storage/ent/mediaasset"
	"github.com/relanox/relanox/internal/storage/ent/outbound"
)

func (s *Store) GetInbound(ctx context.Context, id string) (*model.InboundRecord, error) {
	row, err := s.client.Inbound.Get(ctx, id)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row.Record, nil
}

func (s *Store) GetOutbound(ctx context.Context, id string) (*model.OutboundRecord, error) {
	row, err := s.client.Outbound.Get(ctx, id)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row.Record, nil
}

func (s *Store) ListInbound(ctx context.Context, input model.ListInboundInput) ([]model.InboundRecord, error) {
	if input.Recent && input.AfterID != "" {
		return nil, errors.New("recent_cursor_unsupported")
	}
	q := s.client.Inbound.Query()
	if input.DispatchStatus != "" {
		q.Where(inbound.StatusEQ(string(input.DispatchStatus)))
	}
	if input.EndpointID != "" {
		q.Where(inbound.EndpointIDEQ(input.EndpointID))
	}
	if input.AfterID != "" {
		q.Where(inbound.IDGT(input.AfterID))
	}
	if input.ChannelIDs != nil {
		q.Where(inbound.ChannelIDIn(input.ChannelIDs...))
	}
	if input.ReadyOnly {
		q.Where(inbound.Ready(true), inbound.Filtered(false), inbound.Redacted(false))
	}
	if input.Recent {
		q.Order(inbound.ByAcceptedAt(sql.OrderDesc()), inbound.ByID(sql.OrderDesc()))
	} else {
		q.Order(inbound.ByID())
	}
	rows, err := q.Limit(bounded(input.Limit, 20, 1000)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]model.InboundRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Record)
	}
	return out, nil
}

func (s *Store) ListPendingInbound(ctx context.Context, input model.ListPendingInboundInput) ([]model.InboundRecord, error) {
	if input.Limit < 1 || input.Limit > 20 {
		return nil, errors.New("invalid_pending_message_limit")
	}
	q := s.client.Inbound.Query().Where(inbound.Ready(true), inbound.Filtered(false), inbound.Redacted(false), inbound.ChannelIDIn(input.ChannelIDs...), inbound.EndpointIDIn(input.EndpointIDs...), pendingInActiveConversation)
	if input.Cursor != nil {
		q.Where(inbound.Or(inbound.AcceptedAtGT(input.Cursor.AcceptedAt.UnixNano()), inbound.And(inbound.AcceptedAtEQ(input.Cursor.AcceptedAt.UnixNano()), inbound.IDGT(input.Cursor.RequestID))))
	}
	rows, err := q.Order(inbound.ByAcceptedAt(), inbound.ByID()).Limit(input.Limit).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]model.InboundRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Record)
	}
	return out, nil
}

func pendingInActiveConversation(selector *sql.Selector) {
	c := sql.Table(conversation.Table).As("current_conversation")
	active := sql.Select(c.C(conversation.FieldID)).From(c).Where(sql.And(sql.EQ(c.C(conversation.FieldActive), true), sql.ColumnsEQ(c.C(conversation.FieldID), selector.C(inbound.FieldChannelID)), sql.ColumnsEQ(c.C(conversation.FieldEndpointID), selector.C(inbound.FieldEndpointID))))
	d := sql.Table(outbound.Table).As("final_delivery")
	completed := sql.Select(d.C(outbound.FieldID)).From(d).Where(sql.And(sql.ColumnsEQ(d.C(outbound.FieldID), selector.C(inbound.FieldFinalDeliveryID)), sql.EQ(d.C(outbound.FieldStatus), string(model.DeliverySent))))
	selector.Where(sql.And(sql.Exists(active), sql.NotExists(completed)))
}

func (s *Store) ListOutbound(ctx context.Context, input model.StatusFilter) ([]model.OutboundRecord, error) {
	q := s.client.Outbound.Query()
	if input.DeliveryStatus != "" {
		q.Where(outbound.StatusEQ(string(input.DeliveryStatus)))
	}
	if input.EndpointID != "" {
		q.Where(outbound.EndpointIDEQ(input.EndpointID))
	}
	if input.AfterID != "" {
		q.Where(outbound.IDGT(input.AfterID))
	}
	rows, err := q.Order(outbound.ByID()).Limit(bounded(input.Limit, 20, 1000)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]model.OutboundRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Record)
	}
	return out, nil
}

func (s *Store) Stats(ctx context.Context) (model.StorageStats, error) {
	var stats model.StorageStats
	pending, err := s.client.Inbound.Query().Where(inbound.StatusEQ(string(model.AttemptDue))).Count(ctx)
	if err != nil {
		return stats, err
	}
	stats.Pending = int64(pending)
	undelivered, err := s.client.Outbound.Query().Where(outbound.StatusNEQ(string(model.DeliverySent))).Count(ctx)
	if err != nil {
		return stats, err
	}
	stats.Undelivered = int64(undelivered)
	unknownInbound, err := s.client.Inbound.Query().Where(inbound.StatusEQ(string(model.AttemptUnknown))).Count(ctx)
	if err != nil {
		return stats, err
	}
	unknownOutbound, err := s.client.Outbound.Query().Where(outbound.StatusEQ(string(model.DeliveryUnknown))).Count(ctx)
	if err != nil {
		return stats, err
	}
	stats.Unknown = int64(unknownInbound + unknownOutbound)
	if pending > 0 {
		oldest, err := s.client.Inbound.Query().Where(inbound.StatusEQ(string(model.AttemptDue))).Order(inbound.ByAcceptedAt()).Select(inbound.FieldID, inbound.FieldAcceptedAt).First(ctx)
		if err != nil {
			return stats, err
		}
		at := time.Unix(0, oldest.AcceptedAt).UTC()
		stats.OldestPendingAt = &at
	}
	return stats, nil
}

func (s *Store) Cleanup(ctx context.Context, input model.CleanupInput) (int64, error) {
	input.Limit = bounded(input.Limit, 100, 1000)
	var count int64
	err := s.write(ctx, func(tx *ent.Tx) error {
		count = 0
		rows, err := tx.Inbound.Query().Where(inbound.StatusIn(string(model.AttemptAccepted), string(model.AttemptRejected)), inbound.AcceptedAtLT(input.Before.UnixNano()), inbound.Redacted(false)).Order(inbound.ByAcceptedAt(), inbound.ByID()).Limit(input.Limit).All(ctx)
		if err != nil {
			return err
		}
		for _, row := range rows {
			r := row.Record
			r.Version++
			r.RedactedAt = &input.Before
			r.Preparation = nil
			r.Snapshot.Text = ""
			r.Snapshot.Context = nil
			r.Snapshot.Attachments = nil
			r.Snapshot.Target.Data = nil
			r.Snapshot.Target.ReplyToID = ""
			if err := saveInbound(ctx, tx, r); err != nil {
				return err
			}
			count++
		}
		deliveries, err := tx.Outbound.Query().Where(outbound.StatusEQ(string(model.DeliverySent)), outbound.CreatedAtLT(input.Before.UnixNano()), outbound.Redacted(false)).Order(outbound.ByCreatedAt(), outbound.ByID()).Limit(input.Limit).All(ctx)
		if err != nil {
			return err
		}
		for _, row := range deliveries {
			r := redactedDelivery(row.Record, input.Before)
			if err := saveOutbound(ctx, tx, r); err != nil {
				return err
			}
			count++
		}
		return cleanupMedia(ctx, tx, input)
	})
	return count, err
}

func redactedDelivery(record model.OutboundRecord, before time.Time) model.OutboundRecord {
	record.Version++
	record.RedactedAt = &before
	record.Target.Data = nil
	record.Target.ReplyToID = ""
	for i, chunk := range record.Chunks {
		record.Chunks[i] = model.DeliveryChunk{IdempotencyKey: chunk.IdempotencyKey}
	}
	for i := range record.Receipts {
		record.Receipts[i] = model.SendReceipt{}
	}
	return record
}

func cleanupMedia(ctx context.Context, tx *ent.Tx, input model.CleanupInput) error {
	ids, err := tx.MediaAsset.Query().Where(mediaasset.Retained(true), mediaasset.CreatedAtLT(input.Before.UnixNano()), mediaasset.Not(mediaasset.HasInboundsWith(inbound.Redacted(false))), mediaasset.Not(mediaasset.HasOutboundsWith(outbound.Redacted(false))), func(selector *sql.Selector) {
		dependent := sql.Table(mediaasset.Table).As("staged_preview_owner")
		query := sql.Select(dependent.C(mediaasset.FieldID)).From(dependent).Where(sql.And(sql.ColumnsEQ(dependent.C(mediaasset.FieldPreviewID), selector.C(mediaasset.FieldID)), sql.EQ(dependent.C(mediaasset.FieldRetained), true), sql.EQ(dependent.C(mediaasset.FieldStaged), true), sql.GTE(dependent.C(mediaasset.FieldCreatedAt), input.Before.UnixNano())))
		selector.Where(sql.NotExists(query))
	}).Order(mediaasset.ByCreatedAt(), mediaasset.ByID()).Limit(input.Limit).IDs(ctx)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	return tx.MediaAsset.Update().Where(mediaasset.IDIn(ids...)).SetRetained(false).SetStaged(false).ClearData().Exec(ctx)
}
