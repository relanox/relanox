package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"mime"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/model"
)

func storeUpload(upload model.MediaUpload, id string, maximum int64) (model.StoredMedia, error) {
	if _, err := uuid.Parse(id); err != nil {
		return model.StoredMedia{}, failure("invalid_media_id")
	}
	if !slices.Contains([]model.MediaKind{model.Image, model.Audio, model.Video, model.File}, upload.Kind) {
		return model.StoredMedia{}, failure("invalid_media_type")
	}
	typeName, parameters, err := mime.ParseMediaType(upload.MIMEType)
	if err != nil || len(parameters) > 0 || len(upload.MIMEType) > 128 || strings.ToLower(upload.MIMEType) != typeName {
		return model.StoredMedia{}, failure("invalid_media_type")
	}
	if upload.Kind != model.File && !strings.HasPrefix(typeName, string(upload.Kind)+"/") {
		return model.StoredMedia{}, failure("invalid_media_type")
	}
	if !validFilename(upload.FileName) {
		return model.StoredMedia{}, failure("invalid_media_filename")
	}
	if upload.DurationMS != nil && *upload.DurationMS <= 0 {
		return model.StoredMedia{}, failure("invalid_media_duration")
	}
	if upload.PreviewMediaID != "" {
		if _, err := uuid.Parse(upload.PreviewMediaID); err != nil {
			return model.StoredMedia{}, failure("invalid_media_preview")
		}
	}
	if len(upload.Data) < 1 || int64(len(upload.Data)) > maximum {
		return model.StoredMedia{}, failure("media_too_large")
	}
	data := append([]byte(nil), upload.Data...)
	sum := sha256.Sum256(data)
	return model.StoredMedia{Reference: model.MediaReference{ID: id, Kind: upload.Kind, MIMEType: typeName, FileName: upload.FileName, DurationMS: upload.DurationMS, PreviewMediaID: upload.PreviewMediaID, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}, Data: data}, nil
}

func validFilename(name string) bool {
	if name == "" || len(name) > 256 || name == "." || name == ".." || !utf8.ValidString(name) || strings.ContainsAny(name, "/\\") {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func verifiedMedia(asset model.StoredMedia, ref model.MediaReference, maximum int64) (model.StoredMedia, error) {
	checked, err := storeUpload(model.MediaUpload{Kind: asset.Reference.Kind, MIMEType: asset.Reference.MIMEType, FileName: asset.Reference.FileName, DurationMS: asset.Reference.DurationMS, PreviewMediaID: asset.Reference.PreviewMediaID, Data: asset.Data}, asset.Reference.ID, maximum)
	if err != nil || !equal(checked.Reference, ref) {
		return model.StoredMedia{}, failure("media_integrity_error")
	}
	return checked, nil
}

type agentMedia struct{ scope *scopedAgent }

func (h *agentMedia) Limits() model.MediaLimits { return h.scope.runtime.cfg.Media }

func (h *agentMedia) Authorize(ctx context.Context, channelID string) (bool, error) {
	conversation, err := h.scope.authorized(ctx, channelID)
	return conversation != nil, err
}

func (h *agentMedia) Upload(ctx context.Context, channelID, id string, upload model.MediaUpload) (*model.MediaReference, error) {
	allowed, err := h.Authorize(ctx, channelID)
	if err != nil || !allowed {
		return nil, err
	}
	media, err := storeUpload(upload, id, h.Limits().MaxBytes)
	if err != nil {
		return nil, err
	}
	limits := h.Limits()
	limits.MaxAttachments *= 2
	limits.MaxTotalBytes *= 2
	result, err := h.scope.runtime.store.PutMedia(ctx, model.PutMediaInput{ChannelID: channelID, Agent: h.scope.kind, EndpointIDs: h.scope.principal.EndpointIDs, Media: media, Limits: limits})
	if err != nil || result.Status == model.Unauthorized {
		return nil, err
	}
	if result.Status != model.Stored {
		if result.Status == model.Conflict {
			return nil, failure("media_conflict")
		}
		return nil, failure(string(result.Status))
	}
	return result.Reference, nil
}

func (h *agentMedia) Read(ctx context.Context, channelID, id string) (*model.StoredMedia, error) {
	allowed, err := h.Authorize(ctx, channelID)
	if err != nil || !allowed {
		return nil, err
	}
	asset, err := h.scope.runtime.store.GetMedia(ctx, channelID, id)
	if err != nil || asset == nil {
		return nil, err
	}
	checked, err := verifiedMedia(*asset, asset.Reference, h.Limits().MaxBytes)
	if err != nil {
		return nil, err
	}
	return &checked, nil
}

type preparedMedia struct {
	references []model.MediaReference
	assets     map[string]model.StoredMedia
}

func generatedMedia(channel, intent string, upload model.MediaUpload, maximum int64) (model.StoredMedia, error) {
	asset, err := storeUpload(upload, uuid.NewString(), maximum)
	if err != nil {
		return asset, err
	}
	metadata := asset.Reference
	metadata.ID = ""
	sum := sha256.Sum256(canonical([]any{channel, intent, metadata}))
	id := uuid.UUID(sum[:16])
	id[6] = (id[6] & 0x0f) | 0x80
	id[8] = (id[8] & 0x3f) | 0x80
	asset.Reference.ID = id.String()
	return asset, nil
}

func prepareMedia(ctx context.Context, store model.Storage, channel, intent string, attachments []model.AgentAttachment, limits model.MediaLimits, recovery bool) (preparedMedia, error) {
	result := preparedMedia{assets: map[string]model.StoredMedia{}}
	if len(attachments) > limits.MaxAttachments {
		return result, failure("too_many_attachments")
	}
	seen := map[string]bool{}
	for _, attachment := range attachments {
		ref, assets, err := prepareAttachment(ctx, store, channel, intent, attachment, limits.MaxBytes, recovery)
		if err != nil {
			return result, err
		}
		if seen[ref.ID] {
			return result, failure("duplicate_attachment")
		}
		seen[ref.ID] = true
		result.references = append(result.references, ref)
		for _, asset := range assets {
			result.assets[asset.Reference.ID] = asset
		}
	}
	return result, nil
}

func prepareAttachment(ctx context.Context, store model.Storage, channel, intent string, input model.AgentAttachment, maximum int64, recovery bool) (model.MediaReference, []model.StoredMedia, error) {
	if (input.MediaID == "") == (input.Upload == nil) || input.Preview != nil && input.Upload == nil {
		return model.MediaReference{}, nil, failure("invalid_attachment")
	}
	if input.Upload != nil {
		return generatedGraph(channel, intent, input, maximum)
	}
	if _, err := uuid.Parse(input.MediaID); err != nil {
		return model.MediaReference{}, nil, failure("invalid_media_id")
	}
	if recovery {
		ref, err := store.GetReference(ctx, channel, input.MediaID)
		if err != nil {
			return model.MediaReference{}, nil, err
		}
		if ref == nil {
			return model.MediaReference{}, nil, failure("media_not_found")
		}
		return *ref, nil, nil
	}
	asset, err := store.GetMedia(ctx, channel, input.MediaID)
	if err != nil {
		return model.MediaReference{}, nil, err
	}
	if asset == nil {
		return model.MediaReference{}, nil, failure("media_not_found")
	}
	checked, err := verifiedMedia(*asset, asset.Reference, maximum)
	return checked.Reference, []model.StoredMedia{checked}, err
}

func generatedGraph(channel, intent string, input model.AgentAttachment, maximum int64) (model.MediaReference, []model.StoredMedia, error) {
	upload := *input.Upload
	var assets []model.StoredMedia
	if input.Preview != nil {
		if upload.PreviewMediaID != "" || input.Preview.Kind != model.Image || input.Preview.PreviewMediaID != "" {
			return model.MediaReference{}, nil, failure("invalid_media_preview")
		}
		preview, err := generatedMedia(channel, intent, *input.Preview, maximum)
		if err != nil {
			return model.MediaReference{}, nil, err
		}
		upload.PreviewMediaID = preview.Reference.ID
		assets = append(assets, preview)
	}
	primary, err := generatedMedia(channel, intent, upload, maximum)
	if err != nil {
		return model.MediaReference{}, nil, err
	}
	return primary.Reference, append(assets, primary), nil
}

func completeMedia(ctx context.Context, store model.Storage, channel string, prepared preparedMedia, limits model.MediaLimits) ([]model.StoredMedia, error) {
	used := map[string]model.StoredMedia{}
	for _, ref := range prepared.references {
		asset, err := readPreparedAsset(ctx, store, channel, ref.ID, prepared, limits.MaxBytes)
		if err != nil {
			return nil, err
		}
		if !equal(asset.Reference, ref) {
			return nil, failure("media_integrity_error")
		}
		used[ref.ID] = asset
		if ref.PreviewMediaID != "" {
			preview, err := readPreparedAsset(ctx, store, channel, ref.PreviewMediaID, prepared, limits.MaxBytes)
			if err != nil {
				return nil, err
			}
			if preview.Reference.Kind != model.Image || preview.Reference.PreviewMediaID != "" {
				return nil, failure("invalid_media_preview")
			}
			used[preview.Reference.ID] = preview
		}
	}
	var total int64
	assets := make([]model.StoredMedia, 0, len(used))
	for _, asset := range used {
		total += asset.Reference.Size
		assets = append(assets, asset)
	}
	if total > limits.MaxTotalBytes {
		return nil, failure("media_total_too_large")
	}
	return assets, nil
}

func readPreparedAsset(ctx context.Context, store model.Storage, channel, id string, prepared preparedMedia, maximum int64) (model.StoredMedia, error) {
	if asset, ok := prepared.assets[id]; ok {
		return asset, nil
	}
	asset, err := store.GetMedia(ctx, channel, id)
	if err != nil {
		return model.StoredMedia{}, err
	}
	if asset == nil {
		return model.StoredMedia{}, failure("media_not_found")
	}
	return verifiedMedia(*asset, asset.Reference, maximum)
}
