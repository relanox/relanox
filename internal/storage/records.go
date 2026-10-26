package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage/ent"
	"github.com/relanox/relanox/internal/storage/ent/conversation"
)

func canonical(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var normalized any
	if decoder.Decode(&normalized) != nil {
		return nil
	}
	data, err = json.Marshal(normalized)
	if err != nil {
		return nil
	}
	return data
}

func equal(a, b any) bool {
	left, right := canonical(a), canonical(b)
	return left != nil && right != nil && bytes.Equal(left, right)
}

func digest(value any) string {
	sum := sha256.Sum256(canonical(value))
	return hex.EncodeToString(sum[:])
}

func messageDigest(message model.OutboundMessage) string {
	message.MessageID = ""
	message.CreatedAt = time.Time{}
	return digest(message)
}

func inScope(record model.ConversationRecord, agent model.AgentKind, endpoints []string) bool {
	return record.Endpoint.Agent == agent && slices.Contains(endpoints, record.Endpoint.ID)
}

func targetMatches(target model.ReplyTarget, address model.ChannelAddress) bool {
	return target.Channel == address.Platform && target.AccountID == address.AccountID && target.ChatID == address.ChatID && target.ThreadID == address.ThreadID
}

func (s *Store) RegisterConversations(ctx context.Context, records []model.ConversationRecord) error {
	return s.write(ctx, func(tx *ent.Tx) error {
		if err := tx.Conversation.Update().SetActive(false).Exec(ctx); err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, record := range records {
			if record.Address.ID == "" || seen[record.Address.ID] || record.Endpoint.ID == "" {
				return errors.New("invalid_conversation")
			}
			seen[record.Address.ID] = true
			if err := registerConversation(ctx, tx, record); err != nil {
				return err
			}
		}
		return nil
	})
}

func registerConversation(ctx context.Context, tx *ent.Tx, record model.ConversationRecord) error {
	previous, err := tx.Conversation.Get(ctx, record.Address.ID)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	if previous != nil {
		if !equal(previous.Record.Address, record.Address) || !equal(previous.Record.Endpoint, record.Endpoint) {
			return errors.New("conversation_identity_conflict")
		}
		if previous.Record.Target != nil {
			record.Target = previous.Record.Target
		}
		return tx.Conversation.UpdateOneID(record.Address.ID).SetActive(true).SetRecord(record).Exec(ctx)
	}
	return tx.Conversation.Create().SetID(record.Address.ID).SetActive(true).SetEndpointID(record.Endpoint.ID).SetAgent(string(record.Endpoint.Agent)).SetRecord(record).Exec(ctx)
}

func (s *Store) GetConversation(ctx context.Context, id string, includeInactive bool) (*model.ConversationRecord, error) {
	q := s.client.Conversation.Query().Where(conversation.IDEQ(id))
	if !includeInactive {
		q.Where(conversation.Active(true))
	}
	row, err := q.Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row.Record, nil
}

func scopedConversation(ctx context.Context, tx *ent.Tx, id string, agent model.AgentKind, endpoints []string) (*model.ConversationRecord, error) {
	row, err := tx.Conversation.Query().Where(conversation.IDEQ(id), conversation.Active(true), conversation.AgentEQ(string(agent)), conversation.EndpointIDIn(endpoints...)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row.Record, nil
}

func filtered(record model.InboundRecord) bool {
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

func needsPreparation(record model.InboundRecord) bool {
	return record.RedactedAt == nil && !filtered(record) && len(record.Preparation) < len(record.Snapshot.Preparation)
}

func saveInbound(ctx context.Context, tx *ent.Tx, record model.InboundRecord) error {
	update := tx.Inbound.UpdateOneID(record.Snapshot.RequestID).SetRecord(record).SetVersion(record.Version).SetStatus(string(record.Dispatch.Status)).SetDueAt(record.Dispatch.DueAt.UnixNano()).SetReady(!needsPreparation(record)).SetFiltered(filtered(record)).SetRedacted(record.RedactedAt != nil).SetFinalDeliveryID(record.FinalDeliveryID)
	if record.Dispatch.Lease == nil {
		update.ClearLeaseExpiresAt()
	} else {
		update.SetLeaseExpiresAt(record.Dispatch.Lease.ExpiresAt.UnixNano())
	}
	return update.Exec(ctx)
}

func saveOutbound(ctx context.Context, tx *ent.Tx, record model.OutboundRecord) error {
	update := tx.Outbound.UpdateOneID(record.DeliveryID).SetRecord(record).SetVersion(record.Version).SetStatus(string(record.Status)).SetDueAt(record.DueAt.UnixNano()).SetRedacted(record.RedactedAt != nil)
	if record.Lease == nil {
		update.ClearLeaseExpiresAt()
	} else {
		update.SetLeaseExpiresAt(record.Lease.ExpiresAt.UnixNano())
	}
	return update.Exec(ctx)
}

func bounded(limit, defaultLimit, maximum int) int {
	if limit < 1 {
		return defaultLimit
	}
	return min(limit, maximum)
}

func validLease(stored *model.Lease, attempt model.Lease, now time.Time) bool {
	return stored != nil && stored.Token == attempt.Token && stored.Version == attempt.Version && stored.ExpiresAt.Equal(attempt.ExpiresAt) && stored.ExpiresAt.After(now)
}
