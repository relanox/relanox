package storage

import (
	"context"
	"errors"
	"slices"
	"time"

	"entgo.io/ent/dialect/sql"
	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage/ent"
	"github.com/relanox/relanox/internal/storage/ent/inbound"
	"github.com/relanox/relanox/internal/storage/ent/outbound"
)

func (s *Store) TakeDue(ctx context.Context, input model.TakeDueInput) ([]model.DueWork, error) {
	if input.LeaseDuration <= 0 || input.LeaseOwner == "" {
		return nil, errors.New("invalid_work_lease")
	}
	input.Limit = bounded(input.Limit, 20, 100)
	if input.SendLeaseDuration <= 0 {
		input.SendLeaseDuration = input.LeaseDuration
	}
	var work []model.DueWork
	err := s.write(ctx, func(tx *ent.Tx) error {
		work = nil
		if err := expireWork(ctx, tx, input); err != nil {
			return err
		}
		requests, err := tx.Inbound.Query().Where(inbound.StatusEQ(string(model.AttemptDue)), inbound.LeaseExpiresAtIsNil(), inbound.DueAtLTE(input.Now.UnixNano())).Order(inbound.ByAcceptedAt(), inbound.ByID()).Limit(input.Limit).All(ctx)
		if err != nil {
			return err
		}
		deliveries, err := tx.Outbound.Query().Where(outbound.StatusEQ(string(model.DeliveryPending)), outbound.LeaseExpiresAtIsNil(), outbound.DueAtLTE(input.Now.UnixNano()), noEarlierDelivery).Order(outbound.ByCreatedAt(), outbound.ByID()).Limit(input.Limit).All(ctx)
		if err != nil {
			return err
		}
		preferred := input.PreferredKind
		if preferred == "" {
			row, err := tx.Metadata.Get(ctx, "schema")
			if err != nil {
				return err
			}
			preferred = model.WorkKind(row.NextWork)
		}
		work, preferred, err = claimWork(ctx, tx, input, requests, deliveries, preferred)
		if err != nil {
			return err
		}
		return tx.Metadata.UpdateOneID("schema").SetNextWork(string(preferred)).Exec(ctx)
	})
	return work, err
}

// This correlated typed selector enforces FIFO in the database before LIMIT.
// QQ's native reply sequence can safely proceed past an unknown older response.
func noEarlierDelivery(selector *sql.Selector) {
	earlier := sql.Table(outbound.Table).As("earlier_delivery")
	older := sql.Or(sql.ColumnsLT(earlier.C(outbound.FieldCreatedAt), selector.C(outbound.FieldCreatedAt)), sql.And(sql.ColumnsEQ(earlier.C(outbound.FieldCreatedAt), selector.C(outbound.FieldCreatedAt)), sql.ColumnsLT(earlier.C(outbound.FieldID), selector.C(outbound.FieldID))))
	blocking := sql.And(sql.In(earlier.C(outbound.FieldStatus), string(model.DeliveryPending), string(model.DeliveryUnknown)), sql.Or(sql.EQ(earlier.C(outbound.FieldStatus), string(model.DeliveryPending)), sql.NEQ(earlier.C(outbound.FieldChannel), string(model.QQ))))
	query := sql.Select(earlier.C(outbound.FieldID)).From(earlier).Where(sql.And(sql.ColumnsEQ(earlier.C(outbound.FieldChannelID), selector.C(outbound.FieldChannelID)), older, blocking))
	selector.Where(sql.NotExists(query))
}

func expireWork(ctx context.Context, tx *ent.Tx, input model.TakeDueInput) error {
	requests, err := tx.Inbound.Query().Where(inbound.StatusEQ(string(model.AttemptDue)), inbound.LeaseExpiresAtLTE(input.Now.UnixNano())).Order(inbound.ByAcceptedAt(), inbound.ByID()).Limit(input.Limit).All(ctx)
	if err != nil {
		return err
	}
	for _, row := range requests {
		record := row.Record
		record.Version++
		record.Dispatch.Lease = nil
		if needsPreparation(record) {
			record.Preparation = failedPreparation(record.Snapshot.Preparation, "interrupted")
		} else {
			record.Dispatch.Status = model.AttemptUnknown
			record.Dispatch.ErrorCode = "lease_expired"
		}
		if err := saveInbound(ctx, tx, record); err != nil {
			return err
		}
	}
	deliveries, err := tx.Outbound.Query().Where(outbound.StatusEQ(string(model.DeliveryPending)), outbound.LeaseExpiresAtLTE(input.Now.UnixNano())).Order(outbound.ByCreatedAt(), outbound.ByID()).Limit(input.Limit).All(ctx)
	if err != nil {
		return err
	}
	for _, row := range deliveries {
		record := row.Record
		record.Version++
		record.Lease = nil
		record.Status = model.DeliveryUnknown
		record.ErrorCode = "lease_expired"
		if slices.Contains(input.SafeRetryAccountIDs, record.Target.AccountID) {
			record.Status = model.DeliveryPending
		}
		if err := saveOutbound(ctx, tx, record); err != nil {
			return err
		}
	}
	return nil
}

func failedPreparation(plans []model.PreparationPlan, code string) []model.PreparationResult {
	results := make([]model.PreparationResult, 0, len(plans))
	for _, plan := range plans {
		results = append(results, model.PreparationResult{ID: plan.ID, Status: "failed", ErrorCode: code})
	}
	return results
}

func claimWork(ctx context.Context, tx *ent.Tx, input model.TakeDueInput, requests []*ent.Inbound, deliveries []*ent.Outbound, preferred model.WorkKind) ([]model.DueWork, model.WorkKind, error) {
	work := make([]model.DueWork, 0, input.Limit)
	for len(work) < input.Limit && (len(requests) > 0 || len(deliveries) > 0) {
		if len(requests) > 0 && (preferred != model.SendWork || len(deliveries) == 0) {
			record := requests[0].Record
			requests = requests[1:]
			lease := makeLease(input, record.Version+1, input.LeaseDuration)
			record.Version = lease.Version
			record.Dispatch.Lease = &lease
			if err := saveInbound(ctx, tx, record); err != nil {
				return nil, preferred, err
			}
			kind := model.DispatchWork
			if needsPreparation(record) {
				kind = model.PrepareWork
			}
			work = append(work, model.DueWork{Kind: kind, Inbound: &record, Lease: lease})
			preferred = model.SendWork
			continue
		}
		record := deliveries[0].Record
		deliveries = deliveries[1:]
		lease := makeLease(input, record.Version+1, input.SendLeaseDuration)
		record.Version = lease.Version
		record.Lease = &lease
		if err := saveOutbound(ctx, tx, record); err != nil {
			return nil, preferred, err
		}
		work = append(work, model.DueWork{Kind: model.SendWork, Outbound: &record, Lease: lease})
		preferred = model.DispatchWork
	}
	return work, preferred, nil
}

func makeLease(input model.TakeDueInput, version int64, duration time.Duration) model.Lease {
	return model.Lease{Token: input.LeaseOwner + ":" + uuid.NewString(), Version: version, ExpiresAt: input.Now.Add(duration)}
}

func (s *Store) SettleAttempt(ctx context.Context, input model.Settlement) (model.MutationResult, error) {
	result := model.MutationResult{Status: model.Conflict}
	err := s.write(ctx, func(tx *ent.Tx) error {
		var err error
		if input.Kind == model.SendWork {
			result, err = settleSend(ctx, tx, input)
		} else if input.Kind == model.PrepareWork || input.Kind == model.DispatchWork {
			result, err = settleInbound(ctx, tx, input)
		}
		return err
	})
	return result, err
}

func settleInbound(ctx context.Context, tx *ent.Tx, input model.Settlement) (model.MutationResult, error) {
	row, err := tx.Inbound.Get(ctx, input.ID)
	if ent.IsNotFound(err) {
		return model.MutationResult{Status: model.NotFound}, nil
	}
	if err != nil {
		return model.MutationResult{}, err
	}
	record := row.Record
	if record.Dispatch.Status != model.AttemptDue || !validLease(record.Dispatch.Lease, input.Lease, input.Now) || needsPreparation(record) != (input.Kind == model.PrepareWork) {
		return model.MutationResult{Status: model.Conflict}, nil
	}
	if input.Kind == model.PrepareWork {
		if !validPreparation(record.Snapshot.Preparation, input.Preparation) {
			return model.MutationResult{Status: model.Conflict}, nil
		}
		record.Preparation = input.Preparation
		record.Dispatch.Lease = nil
		record.Dispatch.DueAt = input.Now
		if filtered(record) {
			record.Dispatch.Status = model.AttemptRejected
			record.Dispatch.ErrorCode = "middleware_filtered"
		}
	} else {
		if !validDispatch(input.Dispatch) {
			return model.MutationResult{Status: model.Conflict}, nil
		}
		status := model.AttemptStatus(input.Dispatch.Status)
		if input.Dispatch.Status == model.Retryable {
			status = model.AttemptDue
		}
		record.Dispatch = model.AttemptState{Status: status, Attempts: record.Dispatch.Attempts + 1, DueAt: input.NextDueAt, ErrorCode: input.Dispatch.ErrorCode}
	}
	record.Version++
	if err := saveInbound(ctx, tx, record); err != nil {
		return model.MutationResult{}, err
	}
	return model.MutationResult{Status: model.Updated, Version: record.Version}, nil
}

func validPreparation(plans []model.PreparationPlan, results []model.PreparationResult) bool {
	if len(results) > len(plans) {
		return false
	}
	for i, result := range results {
		if result.ID != plans[i].ID || !slices.Contains([]string{"completed", "failed"}, result.Status) {
			return false
		}
		if result.Status == "completed" && result.Output == nil || result.Status == "failed" && result.Output != nil {
			return false
		}
		if result.Output != nil && result.Output.Filtered {
			return i == len(results)-1
		}
	}
	return len(plans) == len(results)
}

func validDispatch(result *model.DispatchResult) bool {
	return result != nil && slices.Contains([]model.Outcome{model.Accepted, model.Rejected, model.Unknown, model.Retryable}, result.Status)
}

func settleSend(ctx context.Context, tx *ent.Tx, input model.Settlement) (model.MutationResult, error) {
	row, err := tx.Outbound.Get(ctx, input.ID)
	if ent.IsNotFound(err) {
		return model.MutationResult{Status: model.NotFound}, nil
	}
	if err != nil {
		return model.MutationResult{}, err
	}
	record := row.Record
	if record.Status != model.DeliveryPending || record.Version != input.Lease.Version || !validLease(record.Lease, input.Lease, input.Now) || input.Send == nil {
		return model.MutationResult{Status: model.Conflict}, nil
	}
	if !slices.Contains([]model.Outcome{model.Sent, model.Pending, model.Rejected, model.Unknown, model.Retryable}, input.Send.Status) {
		return model.MutationResult{Status: model.Conflict}, nil
	}
	record.Version++
	record.Lease = nil
	record.DueAt = input.NextDueAt
	record.ErrorCode = ""
	switch input.Send.Status {
	case model.Sent:
		if input.Send.Receipt == nil || record.CurrentChunk >= len(record.Chunks) {
			return model.MutationResult{Status: model.Conflict}, nil
		}
		record.CurrentChunk++
		record.Attempts = 0
		record.Receipts = append(record.Receipts, *input.Send.Receipt)
		if record.CurrentChunk == len(record.Chunks) {
			record.Status = model.DeliverySent
		}
	case model.Pending:
	default:
		record.Attempts++
		record.ErrorCode = input.Send.ErrorCode
		if input.Send.Status != model.Retryable {
			record.Status = model.DeliveryStatus(input.Send.Status)
		}
	}
	if err := saveOutbound(ctx, tx, record); err != nil {
		return model.MutationResult{}, err
	}
	return model.MutationResult{Status: model.Updated, Version: record.Version}, nil
}

func (s *Store) Requeue(ctx context.Context, input model.RequeueInput) (model.MutationResult, error) {
	result := model.MutationResult{Status: model.Conflict}
	err := s.write(ctx, func(tx *ent.Tx) error {
		var err error
		if input.Kind == model.SendWork {
			result, err = requeueSend(ctx, tx, input)
		} else if input.Kind == model.DispatchWork || input.Kind == model.PrepareWork {
			result, err = requeueInbound(ctx, tx, input)
		}
		return err
	})
	return result, err
}

func requeueInbound(ctx context.Context, tx *ent.Tx, input model.RequeueInput) (model.MutationResult, error) {
	row, err := tx.Inbound.Get(ctx, input.ID)
	if ent.IsNotFound(err) {
		return model.MutationResult{Status: model.NotFound}, nil
	}
	if err != nil {
		return model.MutationResult{}, err
	}
	r := row.Record
	if r.Version != input.ExpectedVersion || r.RedactedAt != nil || filtered(r) || r.FinalDeliveryID != "" || !slices.Contains([]model.AttemptStatus{model.AttemptAccepted, model.AttemptRejected, model.AttemptUnknown}, r.Dispatch.Status) || r.Dispatch.Status == model.AttemptUnknown && !input.AcknowledgeUnknown {
		return model.MutationResult{Status: model.Conflict}, nil
	}
	r.Version++
	r.Dispatch = model.AttemptState{Status: model.AttemptDue, DueAt: input.Now}
	if err := saveInbound(ctx, tx, r); err != nil {
		return model.MutationResult{}, err
	}
	return model.MutationResult{Status: model.Updated, Version: r.Version}, nil
}

func requeueSend(ctx context.Context, tx *ent.Tx, input model.RequeueInput) (model.MutationResult, error) {
	row, err := tx.Outbound.Get(ctx, input.ID)
	if ent.IsNotFound(err) {
		return model.MutationResult{Status: model.NotFound}, nil
	}
	if err != nil {
		return model.MutationResult{}, err
	}
	r := row.Record
	if r.Version != input.ExpectedVersion || r.RedactedAt != nil || !slices.Contains([]model.DeliveryStatus{model.DeliveryRejected, model.DeliveryUnknown}, r.Status) || r.Status == model.DeliveryUnknown && !input.AcknowledgeUnknown {
		return model.MutationResult{Status: model.Conflict}, nil
	}
	r.Version++
	r.Status = model.DeliveryPending
	r.Attempts = 0
	r.DueAt = input.Now
	r.Lease = nil
	r.ErrorCode = ""
	if err := saveOutbound(ctx, tx, r); err != nil {
		return model.MutationResult{}, err
	}
	return model.MutationResult{Status: model.Updated, Version: r.Version}, nil
}
