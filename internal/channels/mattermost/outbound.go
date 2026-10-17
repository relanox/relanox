package mattermost

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	mm "github.com/mattermost/mattermost/server/public/model"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	identity, token, err := c.credentials(ctx)
	if err != nil {
		return common.Retry("native_identity_unavailable", 0), nil
	}
	if code := c.validateTarget(input, identity); code != "" {
		return common.Reject(code), nil
	}
	message, err := c.message(ctx, input)
	if err != nil {
		return common.Retry("media_publication_failed", 0), nil
	}
	if text.Length(message, model.Codepoint) > 16000 {
		return common.Reject("text_too_long"), nil
	}
	post := &mm.Post{ChannelId: input.Target.ChatID, Message: message}
	post.RootId = input.Target.ThreadID
	if post.RootId == "" && input.Reply != nil {
		post.RootId = input.Target.ReplyToID
	}
	if input.Media != nil {
		id, err := c.upload(ctx, input, token)
		if err != nil {
			return common.Failure(err, true), nil
		}
		post.FileIds = []string{id}
	}
	var response mm.Post
	if err = common.JSON(ctx, c.client, http.MethodPost, c.config.ServerURL+"/api/v4/posts", bearer(token), post, &response); err != nil {
		c.rejectToken(err)
		return common.Failure(err, false), nil
	}
	if !mm.IsValidId(response.Id) {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}, nil
	}
	return common.Sent(response.Id), nil
}

func (c *Channel) validateTarget(input model.SendInput, identity targetData) string {
	target := input.Target
	var data targetData
	if target.Channel != model.Mattermost || target.AccountID != c.account.ID || !mm.IsValidId(target.ChatID) || (target.ThreadID != "" && !mm.IsValidId(target.ThreadID)) || common.DecodeConfig(target.Data, &data) != nil {
		return "invalid_target"
	}
	if data != identity {
		return "target_identity_changed"
	}
	if input.Reply != nil && target.ThreadID == "" && !mm.IsValidId(target.ReplyToID) {
		return "reply_context_unavailable"
	}
	if input.Chunk.Media != nil && (input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID) {
		return "invalid_media"
	}
	if input.Media != nil && (input.Chunk.Media == nil || int64(len(input.Media.Data)) != input.Media.Reference.Size || len(input.Media.Data) == 0) {
		return "invalid_media"
	}
	if len(input.Chunk.RichText) > 0 {
		limits := c.Capabilities().RichText
		if limits == nil {
			return "media_publication_unavailable"
		}
		return common.ValidateRich(input, *limits, model.Codepoint, common.MediaLimit(c.host))
	}
	return ""
}

func (c *Channel) rejectToken(err error) {
	var native *common.HTTPError
	if errors.As(err, &native) && native.Status == 401 {
		c.identities.Invalidate()
	}
}

func (c *Channel) upload(ctx context.Context, input model.SendInput, token string) (string, error) {
	var response mm.FileUploadResponse
	media := input.Media
	if err := common.MultipartMIME(ctx, c.client, c.config.ServerURL+"/api/v4/files", bearer(token), map[string]string{"channel_id": input.Target.ChatID}, "files", media.Reference.FileName, media.Reference.MIMEType, media.Data, &response); err != nil {
		c.rejectToken(err)
		return "", err
	}
	if len(response.FileInfos) != 1 || response.FileInfos[0] == nil || !mm.IsValidId(response.FileInfos[0].Id) {
		return "", errors.New("media_upload_failed")
	}
	return response.FileInfos[0].Id, nil
}

func (c *Channel) message(ctx context.Context, input model.SendInput) (string, error) {
	if len(input.Chunk.RichText) == 0 {
		return input.Chunk.Text, nil
	}
	var pieces []string
	for _, part := range input.Chunk.RichText {
		if part.Type == "text" {
			pieces = append(pieces, part.Text)
			continue
		}
		value, err := c.host.Media().Publish(ctx, input.ChannelID, part.Media.ID, 24*time.Hour)
		if err != nil {
			return "", err
		}
		label := part.Label
		if label == "" {
			label = part.Media.FileName
		}
		label = strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "\n", " ", "\r", " ").Replace(label)
		pieces = append(pieces, "!["+label+"](<"+value+">)")
	}
	return strings.Join(pieces, "\n\n"), nil
}
