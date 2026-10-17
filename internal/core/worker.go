package core

import (
	"context"
	"slices"
	"time"

	"github.com/relanox/relanox/internal/model"
)

func (r *Runtime) workLoop(ctx context.Context) {
	poll := time.Duration(r.cfg.Queue.PollIntervalMS) * time.Millisecond
	for ctx.Err() == nil {
		processed, err := r.processOne(ctx)
		if err != nil {
			r.workerFailed.Store(true)
			r.observe.Log(ctx, "error", "worker.failed", model.LogFields{Component: "core", ErrorCode: "storage_operation_failed"})
		} else {
			r.workerFailed.Store(false)
		}
		if processed && err == nil {
			continue
		}
		timer := time.NewTimer(poll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (r *Runtime) processOne(ctx context.Context) (bool, error) {
	if !r.accepting.Load() || ctx.Err() != nil {
		return false, nil
	}
	work, err := r.store.TakeDue(ctx, model.TakeDueInput{Now: time.Now().UTC(), LeaseDuration: time.Duration(r.cfg.Queue.LeaseSeconds) * time.Second, SendLeaseDuration: time.Duration(r.cfg.Queue.SendLeaseSeconds) * time.Second, Limit: 1, LeaseOwner: r.owner, SafeRetryAccountIDs: r.safeRetryAccounts()})
	if err != nil || len(work) == 0 {
		return false, err
	}
	settlement := r.execute(ctx, work[0])
	settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	result, err := r.store.SettleAttempt(settleCtx, settlement)
	if err != nil {
		return true, err
	}
	if result.Status != model.Updated {
		r.observe.Count("relanox_settlement_conflicts_total", model.MetricLabels{Component: "core", Operation: string(work[0].Kind)}, 1)
	}
	return true, nil
}

func (r *Runtime) execute(ctx context.Context, work model.DueWork) (settlement model.Settlement) {
	started := time.Now()
	ctx, span := r.workSpan(ctx, work)
	settlement = model.Settlement{Kind: work.Kind, Lease: work.Lease}
	if work.Kind == model.SendWork {
		settlement.ID = work.Outbound.DeliveryID
	} else {
		settlement.ID = work.Inbound.Snapshot.RequestID
	}
	defer func() {
		if recover() != nil {
			if work.Kind == model.PrepareWork {
				settlement.Preparation = failedPlans(work.Inbound.Snapshot.Preparation, "preparation_exception")
			} else if work.Kind == model.SendWork {
				settlement.Send = &model.SendResult{Status: model.Unknown, ErrorCode: "component_exception"}
			} else {
				settlement.Dispatch = &model.DispatchResult{Status: model.Unknown, ErrorCode: "component_exception"}
			}
		}
		settlement.Now = time.Now().UTC()
		settlement.NextDueAt = r.nextDue(settlement, work, settlement.Now)
		outcome, _ := workOutcome(settlement)
		span.End(outcome)
		r.recordWork(ctx, work, settlement, time.Since(started))
	}()
	if work.Kind == model.PrepareWork {
		settlement.Preparation = r.prepare(ctx, *work.Inbound)
		return settlement
	}
	if work.Kind == model.DispatchWork {
		outcome := r.dispatch(ctx, *work.Inbound)
		settlement.Dispatch = &outcome
		return settlement
	}
	outcome := r.send(ctx, *work.Outbound)
	settlement.Send = &outcome
	return settlement
}

func (r *Runtime) workSpan(ctx context.Context, work model.DueWork) (context.Context, model.Span) {
	fields := model.LogFields{Component: "core", Operation: string(work.Kind)}
	var parent *model.TraceContext
	if work.Kind == model.SendWork {
		fields.ChannelID, fields.DeliveryID = work.Outbound.ChannelID, work.Outbound.DeliveryID
		parent = work.Outbound.Trace
	} else {
		fields.ChannelID, fields.RequestID = work.Inbound.Snapshot.Channel.ID, work.Inbound.Snapshot.RequestID
		parent = work.Inbound.Snapshot.Trace
	}
	return r.observe.Span(ctx, string(work.Kind), fields, parent)
}

func (r *Runtime) dispatch(ctx context.Context, record model.InboundRecord) model.DispatchResult {
	if ctx.Err() != nil {
		return model.DispatchResult{Status: model.Retryable, ErrorCode: "call_cancelled"}
	}
	if record.Dispatch.Attempts >= r.cfg.Queue.MaxAttempts {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "retry_budget_exhausted"}
	}
	agent := r.agents[record.Snapshot.Endpoint.ID]
	if agent == nil || agent.Kind() != record.Snapshot.Endpoint.Agent {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "agent_missing"}
	}
	// Reserve 15 seconds for a rotated native credential's bounded persistence
	// plus 5 seconds for settlement. Do not race the call against cancellation:
	// the native component knows whether its remote side effect was transmitted.
	deadline := time.Duration(r.cfg.Queue.LeaseSeconds-20) * time.Second
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	message := preparedMessage(record)
	request := record.Snapshot
	request.Text = message.Text
	result, err := agent.Dispatch(callCtx, model.DispatchInput{Request: request, Extensions: message.Extensions})
	if err != nil {
		return model.DispatchResult{Status: model.Unknown, ErrorCode: "agent_error"}
	}
	if !slices.Contains([]model.Outcome{model.Accepted, model.Rejected, model.Unknown, model.Retryable}, result.Status) || result.RetryAfter < 0 {
		return model.DispatchResult{Status: model.Unknown, ErrorCode: "invalid_agent_outcome"}
	}
	if result.Status == model.Retryable && record.Dispatch.Attempts+1 >= r.cfg.Queue.MaxAttempts {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "retry_budget_exhausted"}
	}
	return result
}

func (r *Runtime) send(ctx context.Context, record model.OutboundRecord) model.SendResult {
	if ctx.Err() != nil {
		return model.SendResult{Status: model.Retryable, ErrorCode: "call_cancelled"}
	}
	if record.Attempts >= r.cfg.Queue.MaxAttempts {
		return model.SendResult{Status: model.Rejected, ErrorCode: "retry_budget_exhausted"}
	}
	channel := r.channel(record.Target.AccountID)
	if channel == nil || channel.Kind() != record.Target.Channel {
		return model.SendResult{Status: model.Rejected, ErrorCode: "channel_missing"}
	}
	if record.CurrentChunk < 0 || record.CurrentChunk >= len(record.Chunks) {
		return model.SendResult{Status: model.Rejected, ErrorCode: "invalid_delivery_chunk"}
	}
	deadline := time.Duration(r.cfg.Queue.SendLeaseSeconds) * time.Second
	if deadline > 10*time.Second {
		deadline -= 5 * time.Second
	} else {
		deadline /= 2
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	input, err := r.sendInput(callCtx, record)
	if err != nil {
		return model.SendResult{Status: model.Rejected, ErrorCode: "media_unavailable"}
	}
	result, err := channel.Send(callCtx, input)
	if err != nil {
		return model.SendResult{Status: model.Unknown, ErrorCode: "channel_error"}
	}
	if !slices.Contains([]model.Outcome{model.Sent, model.Pending, model.Rejected, model.Unknown, model.Retryable}, result.Status) || result.RetryAfter < 0 || result.Status == model.Sent && result.Receipt == nil {
		return model.SendResult{Status: model.Unknown, ErrorCode: "invalid_channel_outcome"}
	}
	if result.Status == model.Retryable && record.Attempts+1 >= r.cfg.Queue.MaxAttempts {
		return model.SendResult{Status: model.Rejected, ErrorCode: "retry_budget_exhausted"}
	}
	return result
}

func (r *Runtime) sendInput(ctx context.Context, record model.OutboundRecord) (model.SendInput, error) {
	chunk := record.Chunks[record.CurrentChunk]
	input := model.SendInput{Reply: record.Reply, DeliveryID: record.DeliveryID, ChannelID: record.ChannelID, Target: record.Target, Chunk: chunk, ChunkIndex: record.CurrentChunk, ChunkCount: len(record.Chunks)}
	if chunk.Media != nil {
		asset, err := r.readChunkAsset(ctx, record.ChannelID, *chunk.Media)
		if err != nil {
			return input, err
		}
		input.Media = &asset
		if asset.Reference.PreviewMediaID != "" {
			preview, err := r.store.GetMedia(ctx, record.ChannelID, asset.Reference.PreviewMediaID)
			if err != nil {
				return input, err
			}
			if preview == nil || preview.Reference.Kind != model.Image || preview.Reference.PreviewMediaID != "" {
				return input, failure("invalid_media_preview")
			}
			verified, err := verifiedMedia(*preview, preview.Reference, r.cfg.Media.MaxBytes)
			if err != nil {
				return input, err
			}
			input.Preview = &verified
		}
	}
	for _, part := range chunk.RichText {
		if part.Type != "image" || part.Media == nil {
			continue
		}
		asset, err := r.readChunkAsset(ctx, record.ChannelID, *part.Media)
		if err != nil {
			return input, err
		}
		input.RichMedia = append(input.RichMedia, asset)
	}
	return input, nil
}

func (r *Runtime) readChunkAsset(ctx context.Context, channelID string, ref model.MediaReference) (model.StoredMedia, error) {
	asset, err := r.store.GetMedia(ctx, channelID, ref.ID)
	if err != nil {
		return model.StoredMedia{}, err
	}
	if asset == nil {
		return model.StoredMedia{}, failure("media_not_found")
	}
	return verifiedMedia(*asset, ref, r.cfg.Media.MaxBytes)
}

func (r *Runtime) nextDue(settlement model.Settlement, work model.DueWork, now time.Time) time.Time {
	var status model.Outcome
	var retry time.Duration
	attempts := 0
	if settlement.Send != nil {
		status = settlement.Send.Status
		retry = settlement.Send.RetryAfter
		attempts = work.Outbound.Attempts
	}
	if settlement.Dispatch != nil {
		status = settlement.Dispatch.Status
		retry = settlement.Dispatch.RetryAfter
		attempts = work.Inbound.Dispatch.Attempts
	}
	if status == model.Pending {
		return now.Add(max(time.Second, retry))
	}
	if status != model.Retryable {
		return now
	}
	if retry == 0 {
		retry = time.Duration(1<<min(attempts, 8)) * time.Second
	}
	return now.Add(max(time.Second, min(retry, 24*time.Hour)))
}

func workOutcome(settlement model.Settlement) (string, string) {
	if settlement.Dispatch != nil {
		return string(settlement.Dispatch.Status), settlement.Dispatch.ErrorCode
	}
	if settlement.Send != nil {
		return string(settlement.Send.Status), settlement.Send.ErrorCode
	}
	for _, result := range settlement.Preparation {
		if result.Status == "failed" {
			return "failed", result.ErrorCode
		}
	}
	return "prepared", ""
}

func (r *Runtime) recordWork(ctx context.Context, work model.DueWork, settlement model.Settlement, elapsed time.Duration) {
	status, code := workOutcome(settlement)
	labels := model.MetricLabels{Component: "core", Operation: string(work.Kind)}
	fields := model.LogFields{Component: "core", Operation: string(work.Kind)}
	if settlement.Dispatch != nil {
		labels.Agent = work.Inbound.Snapshot.Endpoint.Agent
		fields.RequestID = settlement.ID
	}
	if settlement.Send != nil {
		labels.Channel = work.Outbound.Target.Channel
		fields.DeliveryID = settlement.ID
		fields.ChannelID = work.Outbound.ChannelID
	}
	labels.Outcome = status
	fields.Outcome = status
	fields.ErrorCode = code
	r.observe.Count("relanox_work_total", labels, 1)
	metric := map[model.WorkKind]string{model.PrepareWork: "relanox_preparation_duration_seconds", model.DispatchWork: "relanox_dispatch_duration_seconds", model.SendWork: "relanox_send_duration_seconds"}[work.Kind]
	r.observe.Record(metric, elapsed.Seconds(), labels)
	r.observe.Log(ctx, "info", "work.completed", fields)
}

func (r *Runtime) maintenanceLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		stats, err := r.store.Stats(ctx)
		if err == nil {
			r.observe.Record("relanox_pending", float64(stats.Pending), model.MetricLabels{})
			r.observe.Record("relanox_outbound", float64(stats.Undelivered), model.MetricLabels{})
			r.observe.Record("relanox_unknown", float64(stats.Unknown), model.MetricLabels{})
		}
		_, err = r.store.Cleanup(ctx, model.CleanupInput{Before: time.Now().Add(-time.Duration(r.cfg.Queue.RetentionDays) * 24 * time.Hour), Limit: 100})
		if err != nil && ctx.Err() == nil {
			r.observe.Log(ctx, "warn", "cleanup.failed", model.LogFields{Component: "core", ErrorCode: "storage_cleanup_failed"})
		}
	}
}
