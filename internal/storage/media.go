package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"time"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage/ent"
	"github.com/relanox/relanox/internal/storage/ent/mediaasset"
)

func validMedia(asset model.StoredMedia) bool {
	ref := asset.Reference
	if ref.ID == "" || !slices.Contains([]model.MediaKind{model.Image, model.Audio, model.Video, model.File}, ref.Kind) || ref.Size != int64(len(asset.Data)) {
		return false
	}
	if ref.DurationMS != nil && *ref.DurationMS <= 0 {
		return false
	}
	sum := sha256.Sum256(asset.Data)
	return ref.SHA256 == hex.EncodeToString(sum[:])
}

func (s *Store) GetReference(ctx context.Context, channelID, id string) (*model.MediaReference, error) {
	row, err := s.client.MediaAsset.Query().Where(mediaasset.IDEQ(id), mediaasset.ChannelIDEQ(channelID)).Select(mediaasset.FieldID, mediaasset.FieldReference).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row.Reference, nil
}

func (s *Store) GetMedia(ctx context.Context, channelID, id string) (*model.StoredMedia, error) {
	row, err := s.client.MediaAsset.Query().Where(mediaasset.IDEQ(id), mediaasset.ChannelIDEQ(channelID), mediaasset.Retained(true)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &model.StoredMedia{Reference: row.Reference, Data: row.Data}, nil
}

func (s *Store) PutMedia(ctx context.Context, input model.PutMediaInput) (model.PutMediaResult, error) {
	result := model.PutMediaResult{Status: model.Conflict}
	err := s.write(ctx, func(tx *ent.Tx) error {
		result = model.PutMediaResult{Status: model.Conflict}
		conversation, err := scopedConversation(ctx, tx, input.ChannelID, input.Agent, input.EndpointIDs)
		if err != nil {
			return err
		}
		if conversation == nil {
			result.Status = model.Unauthorized
			return nil
		}
		if !validMedia(input.Media) {
			return nil
		}
		return stageMedia(ctx, tx, input, &result)
	})
	return result, err
}

func stageMedia(ctx context.Context, tx *ent.Tx, input model.PutMediaInput, result *model.PutMediaResult) error {
	previous, err := tx.MediaAsset.Get(ctx, input.Media.Reference.ID)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	if previous != nil {
		if previous.ChannelID == input.ChannelID && equal(previous.Reference, input.Media.Reference) {
			result.Status = model.Stored
			result.Reference = &previous.Reference
		}
		return nil
	}
	if len(input.Media.Data) < 1 || input.Limits.MaxBytes < 1 || int64(len(input.Media.Data)) > input.Limits.MaxBytes {
		result.Status = model.MediaTooLarge
		return nil
	}
	valid, err := validPreview(ctx, tx, input.ChannelID, input.Media.Reference)
	if err != nil {
		return err
	}
	if !valid {
		result.Status = model.InvalidMediaPreview
		return nil
	}
	count, bytes, err := stagedBudget(ctx, tx, input.ChannelID)
	if err != nil {
		return err
	}
	if input.Limits.MaxAttachments < 0 || count+1 > input.Limits.MaxAttachments {
		result.Status = model.TooManyAttachments
		return nil
	}
	if input.Limits.MaxTotalBytes < 0 || bytes+input.Media.Reference.Size > input.Limits.MaxTotalBytes {
		result.Status = model.MediaTotalTooLarge
		return nil
	}
	if err := insertMedia(ctx, tx, input.ChannelID, input.Media, true, time.Now()); err != nil {
		return err
	}
	result.Status = model.Stored
	ref := input.Media.Reference
	result.Reference = &ref
	return nil
}

func stagedBudget(ctx context.Context, tx *ent.Tx, channelID string) (int, int64, error) {
	q := tx.MediaAsset.Query().Where(mediaasset.ChannelIDEQ(channelID), mediaasset.Staged(true), mediaasset.Retained(true))
	count, err := q.Clone().Count(ctx)
	if err != nil || count == 0 {
		return count, 0, err
	}
	var totals []int64
	err = q.Aggregate(ent.Sum(mediaasset.FieldSize)).Scan(ctx, &totals)
	if err != nil {
		return count, 0, err
	}
	return count, totals[0], nil
}

func validPreview(ctx context.Context, tx *ent.Tx, channelID string, ref model.MediaReference) (bool, error) {
	if ref.PreviewMediaID == "" {
		return true, nil
	}
	if ref.PreviewMediaID == ref.ID {
		return false, nil
	}
	preview, err := tx.MediaAsset.Query().Where(mediaasset.IDEQ(ref.PreviewMediaID), mediaasset.ChannelIDEQ(channelID), mediaasset.Retained(true)).Only(ctx)
	if ent.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return preview.Reference.Kind == model.Image && preview.Reference.PreviewMediaID == "", nil
}

func insertMedia(ctx context.Context, tx *ent.Tx, channelID string, asset model.StoredMedia, staged bool, now time.Time) error {
	return tx.MediaAsset.Create().SetID(asset.Reference.ID).SetChannelID(channelID).SetReference(asset.Reference).SetSize(asset.Reference.Size).SetCreatedAt(now.UnixNano()).SetStaged(staged).SetRetained(true).SetPreviewID(asset.Reference.PreviewMediaID).SetData(asset.Data).Exec(ctx)
}

func incomingMedia(ctx context.Context, tx *ent.Tx, snapshot model.InboundSnapshot, assets []model.StoredMedia) ([]string, error) {
	if len(assets) != len(snapshot.Attachments) {
		return nil, errors.New("inbound_media_mismatch")
	}
	seen := map[string]bool{}
	for i, asset := range assets {
		if !validMedia(asset) || seen[asset.Reference.ID] || !equal(asset.Reference, snapshot.Attachments[i]) {
			return nil, errors.New("inbound_media_mismatch")
		}
		seen[asset.Reference.ID] = true
		if err := insertMedia(ctx, tx, snapshot.Channel.ID, asset, false, snapshot.AcceptedAt); err != nil {
			return nil, err
		}
	}
	var ids []string
	for _, asset := range assets {
		valid, err := validPreview(ctx, tx, snapshot.Channel.ID, asset.Reference)
		if err != nil {
			return nil, err
		}
		if !valid {
			return nil, errors.New("inbound_media_preview_invalid")
		}
		ids = append(ids, asset.Reference.ID)
		if asset.Reference.PreviewMediaID != "" {
			ids = append(ids, asset.Reference.PreviewMediaID)
		}
	}
	return ids, nil
}

func mediaIDs(input model.EnqueueMessageInput) []string {
	seen := map[string]bool{}
	for _, ref := range input.Message.Attachments {
		seen[ref.ID] = true
		if ref.PreviewMediaID != "" {
			seen[ref.PreviewMediaID] = true
		}
	}
	for _, asset := range input.Media {
		seen[asset.Reference.ID] = true
		if asset.Reference.PreviewMediaID != "" {
			seen[asset.Reference.PreviewMediaID] = true
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	return ids
}

func resolveMessageMedia(ctx context.Context, tx *ent.Tx, input model.EnqueueMessageInput) ([]string, model.Outcome, error) {
	ids := mediaIDs(input)
	rows, err := tx.MediaAsset.Query().Where(mediaasset.IDIn(ids...)).All(ctx)
	if err != nil {
		return nil, model.Conflict, err
	}
	assets := make(map[string]*ent.MediaAsset, len(rows))
	for _, row := range rows {
		if row.ChannelID != input.ChannelID || !row.Retained {
			return nil, model.Conflict, nil
		}
		assets[row.ID] = row
	}
	additions, valid := mergeMedia(input, assets)
	if !valid {
		return nil, model.Conflict, nil
	}
	used, status := validateGraph(input, assets)
	if status != model.Stored {
		return nil, status, nil
	}
	for _, asset := range additions {
		if !slices.Contains(used, asset.Reference.ID) {
			return nil, model.Conflict, nil
		}
		if err := insertMedia(ctx, tx, input.ChannelID, asset, false, input.Outbound.CreatedAt); err != nil {
			return nil, model.Conflict, err
		}
	}
	if len(used) > 0 {
		_, err = tx.MediaAsset.Update().Where(mediaasset.IDIn(used...)).SetStaged(false).Save(ctx)
	}
	return used, model.Stored, err
}

func mergeMedia(input model.EnqueueMessageInput, assets map[string]*ent.MediaAsset) ([]model.StoredMedia, bool) {
	var additions []model.StoredMedia
	for _, asset := range input.Media {
		if !validMedia(asset) {
			return nil, false
		}
		previous := assets[asset.Reference.ID]
		if previous != nil {
			if !equal(previous.Reference, asset.Reference) {
				return nil, false
			}
			continue
		}
		assets[asset.Reference.ID] = &ent.MediaAsset{ID: asset.Reference.ID, ChannelID: input.ChannelID, Reference: asset.Reference, Size: asset.Reference.Size, Data: asset.Data, Retained: true}
		additions = append(additions, asset)
	}
	return additions, true
}

func validateGraph(input model.EnqueueMessageInput, assets map[string]*ent.MediaAsset) ([]string, model.Outcome) {
	seen := map[string]bool{}
	for _, ref := range input.Message.Attachments {
		asset := assets[ref.ID]
		if asset == nil || !equal(asset.Reference, ref) {
			return nil, model.Conflict
		}
		if ref.Size < 1 || input.Limits.MaxBytes < 1 || ref.Size > input.Limits.MaxBytes {
			return nil, model.MediaTooLarge
		}
		seen[ref.ID] = true
		if ref.PreviewMediaID != "" {
			preview := assets[ref.PreviewMediaID]
			if preview == nil || preview.Reference.Kind != model.Image || preview.Reference.PreviewMediaID != "" || preview.ID == ref.ID {
				return nil, model.InvalidMediaPreview
			}
			seen[preview.ID] = true
		}
	}
	if input.Limits.MaxAttachments < 0 || len(seen) > input.Limits.MaxAttachments {
		return nil, model.TooManyAttachments
	}
	ids := make([]string, 0, len(seen))
	var bytes int64
	for id := range seen {
		bytes += assets[id].Size
		ids = append(ids, id)
	}
	if input.Limits.MaxTotalBytes < 0 || bytes > input.Limits.MaxTotalBytes {
		return nil, model.MediaTotalTooLarge
	}
	return ids, model.Stored
}
