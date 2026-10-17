package wecom

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"slices"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type passiveImage struct {
	Base64 string `json:"base64"`
	MD5    string `json:"md5"`
}

type passiveState struct {
	ID         string         `json:"id"`
	EventID    string         `json:"eventId"`
	ChatID     string         `json:"chatId"`
	ExpiresAt  time.Time      `json:"expiresAt"`
	Content    string         `json:"content"`
	Images     []passiveImage `json:"images"`
	DeliveryID string         `json:"deliveryId"`
	NextChunk  int            `json:"nextChunk"`
	Finish     bool           `json:"finish"`
	Served     bool           `json:"served"`
}

func streamID(botID, eventID string) string {
	digest := sha256.Sum256(common.Data([]string{botID, eventID}))
	return hex.EncodeToString(digest[:])
}

func (c *Channel) startPassive(ctx context.Context, id, eventID, chatID string) error {
	state, entry, err := common.ReadState[passiveState](ctx, c.host.State(), "stream:"+id)
	if err != nil {
		return err
	}
	if entry != nil {
		if state.ID != id || state.EventID != eventID || state.ChatID != chatID {
			return errors.New("callback_identity_mismatch")
		}
		return nil
	}
	expires := time.Now().Add(10 * time.Minute)
	result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: "stream:" + id, ExpiresAt: &expires, Value: common.Data(passiveState{ID: id, EventID: eventID, ChatID: chatID, ExpiresAt: expires, Images: []passiveImage{}})})
	if err != nil {
		return err
	}
	if result.Status != model.Updated && result.Status != model.Conflict {
		return errors.New("callback_state_unavailable")
	}
	return nil
}

func (c *Channel) passiveAvailability(ctx context.Context, id, eventID, chatID string) (string, error) {
	state, entry, err := common.ReadState[passiveState](ctx, c.host.State(), "stream:"+id)
	if err != nil {
		return "", err
	}
	if entry == nil || !state.ExpiresAt.After(time.Now()) {
		return "callback_stream_expired", nil
	}
	if state.EventID != eventID || state.ChatID != chatID {
		return "target_identity_changed", nil
	}
	if state.DeliveryID != "" || state.Finish {
		return "callback_reply_used", nil
	}
	return "", nil
}

func (c *Channel) passiveResponse(ctx context.Context, id, chatID string) (any, error) {
	state, entry, err := common.ReadState[passiveState](ctx, c.host.State(), "stream:"+id)
	if err != nil {
		return nil, err
	}
	if entry == nil || !state.ExpiresAt.After(time.Now()) {
		return nil, nil
	}
	if state.ChatID != chatID {
		return nil, errors.New("callback_identity_mismatch")
	}
	if state.Finish && !state.Served {
		state.Served = true
		result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: entry.Key, ExpectedVersion: &entry.Version, ExpiresAt: &state.ExpiresAt, Value: common.Data(state)})
		if err != nil {
			return nil, err
		}
		if result.Status != model.Updated {
			return nil, errors.New("callback_state_conflict")
		}
	}
	stream := map[string]any{"id": id, "finish": state.Finish, "content": ""}
	if state.Finish {
		stream["content"] = state.Content
		if len(state.Images) > 0 {
			items := make([]any, 0, len(state.Images))
			for _, image := range state.Images {
				items = append(items, map[string]any{"msgtype": "image", "image": image})
			}
			stream["msg_item"] = items
		}
	}
	return map[string]any{"msgtype": "stream", "stream": stream}, nil
}

func appendImage(images []passiveImage, input model.SendInput) ([]passiveImage, string) {
	if input.Chunk.Media != nil && input.Media == nil {
		return nil, "missing_media"
	}
	if input.Media == nil {
		return images, ""
	}
	media := input.Media
	if media.Reference.Kind != model.Image || !slices.Contains([]string{"image/png", "image/jpeg"}, media.Reference.MIMEType) {
		return nil, "unsupported_callback_media"
	}
	if len(media.Data) == 0 || len(media.Data) > 10*1024*1024 || len(images) >= 10 {
		return nil, "unsupported_callback_media_size"
	}
	digest := md5.Sum(media.Data)
	return append(images, passiveImage{Base64: base64.StdEncoding.EncodeToString(media.Data), MD5: hex.EncodeToString(digest[:])}), ""
}

func (c *Channel) stagePassive(ctx context.Context, id, eventID string, input model.SendInput) (model.SendResult, error) {
	state, entry, err := common.ReadState[passiveState](ctx, c.host.State(), "stream:"+id)
	if err != nil {
		return model.SendResult{}, err
	}
	if entry == nil || !state.ExpiresAt.After(time.Now()) {
		return common.Reject("callback_stream_expired"), nil
	}
	if state.EventID != eventID || state.ChatID != input.Target.ChatID {
		return common.Reject("target_identity_changed"), nil
	}
	if state.DeliveryID != "" && state.DeliveryID != input.DeliveryID {
		return common.Reject("callback_reply_used"), nil
	}
	if input.ChunkIndex < state.NextChunk {
		if state.Finish && !state.Served {
			return model.SendResult{Status: model.Pending, RetryAfter: time.Second}, nil
		}
		return common.Sent(""), nil
	}
	if input.ChunkIndex != state.NextChunk || state.Finish {
		return common.Reject("invalid_callback_chunk"), nil
	}
	if ctx.Err() != nil {
		return common.Retry("callback_stopped", 0), nil
	}
	images, code := appendImage(append([]passiveImage{}, state.Images...), input)
	if code != "" {
		return common.Reject(code), nil
	}
	content := state.Content + input.Chunk.Text
	if len(content) > 20*1024 {
		return common.Reject("text_too_long"), nil
	}
	count := input.ChunkCount
	if count <= 0 {
		count = 1
	}
	state.Content = content
	state.Images = images
	state.DeliveryID = input.DeliveryID
	state.NextChunk = input.ChunkIndex + 1
	state.Finish = state.NextChunk == count
	result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: entry.Key, ExpectedVersion: &entry.Version, ExpiresAt: &state.ExpiresAt, Value: common.Data(state)})
	if err != nil {
		return model.SendResult{}, err
	}
	if result.Status != model.Updated {
		return common.Retry("callback_state_conflict", 0), nil
	}
	if state.Finish {
		return model.SendResult{Status: model.Pending, RetryAfter: time.Second}, nil
	}
	receipt := common.Sent("")
	receipt.Receipt.Data = common.Data(map[string]bool{"staged": true})
	return receipt, nil
}
