package core

import (
	"context"
	"encoding/json"
	"time"

	"github.com/relanox/relanox/internal/model"
)

func failedPlans(plans []model.PreparationPlan, code string) []model.PreparationResult {
	results := make([]model.PreparationResult, 0, len(plans))
	for _, plan := range plans {
		results = append(results, model.PreparationResult{ID: plan.ID, Status: "failed", ErrorCode: code})
	}
	return results
}

func (r *Runtime) prepare(ctx context.Context, record model.InboundRecord) []model.PreparationResult {
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(r.cfg.Queue.LeaseSeconds-20)*time.Second)
	defer cancel()
	var results []model.PreparationResult
	for _, plan := range record.Snapshot.Preparation {
		preparer := r.preparers[plan.ID]
		fallback := model.PreparationResult{ID: plan.ID, Status: "failed", ErrorCode: "disabled"}
		if callCtx.Err() != nil {
			fallback.ErrorCode = "timeout"
			results = append(results, fallback)
			continue
		}
		if preparer == nil {
			results = append(results, fallback)
			continue
		}
		record.Preparation = results
		result := r.runPreparation(callCtx, record, plan, preparer)
		results = append(results, result)
		if result.Output != nil && result.Output.Filtered {
			break
		}
	}
	return results
}

func (r *Runtime) runPreparation(ctx context.Context, record model.InboundRecord, plan model.PreparationPlan, preparer model.Preparer) (result model.PreparationResult) {
	result = model.PreparationResult{ID: plan.ID, Status: "failed", ErrorCode: "preparation_failed"}
	defer func() {
		if recover() != nil {
			result = model.PreparationResult{ID: plan.ID, Status: "failed", ErrorCode: "preparation_exception"}
		}
	}()
	output, err := preparer.Process(ctx, model.PreparationInput{Message: preparedMessage(record), Options: plan.Options, ReadMedia: func(ctx context.Context, id string) (*model.StoredMedia, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for _, ref := range record.Snapshot.Attachments {
			if ref.ID != id {
				continue
			}
			asset, err := r.readChunkAsset(ctx, record.Snapshot.Channel.ID, ref)
			if err != nil {
				return nil, err
			}
			return &asset, nil
		}
		return nil, nil
	}})
	if err != nil {
		if ctx.Err() != nil {
			result.ErrorCode = "timeout"
		}
		return result
	}
	if validText(output.Text, true) != nil || len(output.Data) > maxTextBytes || len(output.Data) > 0 && !json.Valid(output.Data) {
		result.ErrorCode = "invalid_preparation_result"
		return result
	}
	return model.PreparationResult{ID: plan.ID, Status: "completed", Output: &output}
}
