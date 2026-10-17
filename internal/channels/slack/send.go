package slack

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	slackapi "github.com/slack-go/slack"
	"github.com/slack-go/slack/slackutilsx"
)

func failure(err error, preparing bool) model.SendResult {
	var rate *slackapi.RateLimitedError
	if errors.As(err, &rate) {
		return common.Retry("rate_limited", rate.RetryAfter)
	}
	var native slackapi.SlackErrorResponse
	if errors.As(err, &native) {
		switch native.Err {
		case "ratelimited":
			return common.Retry("rate_limited", 0)
		case "invalid_auth", "token_revoked", "token_expired":
			return common.Retry("oauth_token_rejected", time.Second)
		case "internal_error", "fatal_error", "service_unavailable", "request_timeout":
		default:
			return common.Reject("slack_api_rejected")
		}
	}
	var status slackapi.StatusCodeError
	if errors.As(err, &status) && status.Code < 500 && status.Code != 408 {
		if status.Code == 429 {
			return common.Retry("rate_limited", 0)
		}
		if status.Code == 401 {
			return common.Retry("oauth_token_rejected", time.Second)
		}
		return common.Reject("platform_request_rejected")
	}
	return common.Failure(err, preparing)
}

func sendThread(input model.SendInput) (string, error) {
	thread := input.Target.ThreadID
	if thread == "" && input.Reply != nil {
		thread = input.Target.ReplyToID
	}
	if thread != "" {
		if _, err := nativeTime(thread); err != nil {
			return "", err
		}
	}
	return thread, nil
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	if !validAddress(input.Target.ChatID, input.Target.ThreadID) {
		return common.Reject("invalid_target"), nil
	}
	client, bot, err := c.client(ctx)
	if err != nil {
		return failure(err, true), nil
	}
	if !c.validTarget(input.Target, bot) {
		return common.Reject("target_identity_changed"), nil
	}
	limits := richLimits
	limits.MaxImageBytes = common.MediaLimit(c.host)
	if code := common.ValidateRich(input, limits, model.Codepoint, common.MediaLimit(c.host)); code != "" {
		return common.Reject(code), nil
	}
	if text.Length(text.Slack(input.Chunk.Text), model.Codepoint) > 4000 {
		return common.Reject("text_limit_exceeded"), nil
	}
	if input.Chunk.IdempotencyKey == "" {
		return common.Reject("missing_idempotency_key"), nil
	}
	thread, err := sendThread(input)
	if err != nil {
		return common.Reject("invalid_native_thread"), nil
	}
	if len(input.Chunk.RichText) > 0 {
		return c.sendRich(ctx, client, input, thread), nil
	}
	if input.Chunk.Media != nil {
		return c.sendMedia(ctx, client, input, thread), nil
	}
	return c.post(ctx, client, input.Target.ChatID, thread, text.Slack(input.Chunk.Text), nil), nil
}

func (c *Channel) post(ctx context.Context, client *slackapi.Client, chat, thread, value string, blocks []slackapi.Block) model.SendResult {
	options := []slackapi.MsgOption{slackapi.MsgOptionText(value, false), slackapi.MsgOptionParse(false), slackapi.MsgOptionLinkNames(false), slackapi.MsgOptionDisableLinkUnfurl(), slackapi.MsgOptionDisableMediaUnfurl()}
	if thread != "" {
		options = append(options, slackapi.MsgOptionTS(thread))
	}
	if len(blocks) > 0 {
		options = append(options, slackapi.MsgOptionBlocks(blocks...))
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0)
	}
	channel, timestamp, err := client.PostMessageContext(ctx, chat, options...)
	if err != nil {
		return failure(err, false)
	}
	if _, err = nativeTime(timestamp); err != nil || channel != chat {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_invalid_response"}
	}
	return common.Sent(timestamp)
}

func (c *Channel) upload(ctx context.Context, client *slackapi.Client, media model.StoredMedia) (slackapi.FileSummary, error) {
	if len(media.Data) == 0 || int64(len(media.Data)) != media.Reference.Size || int64(len(media.Data)) > common.MediaLimit(c.host) || media.Reference.FileName == "" {
		return slackapi.FileSummary{}, errors.New("invalid_media")
	}
	response, err := client.GetUploadURLExternalContext(ctx, slackapi.GetUploadURLExternalParameters{FileName: media.Reference.FileName, FileSize: len(media.Data)})
	if err != nil {
		return slackapi.FileSummary{}, err
	}
	if response == nil || !response.Ok || !nativeID(response.FileID) {
		return slackapi.FileSummary{}, errors.New("invalid_upload_response")
	}
	u, err := url.Parse(response.UploadURL)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || (u.Host != "files.slack.com" && common.Origin(response.UploadURL) != common.Origin(c.config.APIBaseURL)) {
		return slackapi.FileSummary{}, errors.New("invalid_upload_url")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, response.UploadURL, bytes.NewReader(media.Data))
	if err != nil {
		return slackapi.FileSummary{}, err
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	// The SDK UploadToURL helper leaves its private multipart writer blocked on
	// an unbuffered error channel after cancellation (v0.30.1 misc.go:421).
	// Keep this one bounded raw-byte transfer until the SDK can join its writer.
	// The signed URL authenticates the upload; bot credentials are not forwarded.
	// https://github.com/slack-go/slack/blob/v0.30.1/misc.go
	if _, _, err = common.Do(c.http, request, 64*1024); err != nil {
		return slackapi.FileSummary{}, err
	}
	return slackapi.FileSummary{ID: response.FileID, Title: media.Reference.FileName}, nil
}

func validateCompletion(response *slackapi.CompleteUploadExternalResponse, expected []slackapi.FileSummary) bool {
	if response == nil || !response.Ok || len(response.Files) != len(expected) {
		return false
	}
	seen := make(map[string]bool, len(expected))
	for _, file := range response.Files {
		seen[file.ID] = true
	}
	for _, file := range expected {
		if !seen[file.ID] {
			return false
		}
	}
	return true
}

func (c *Channel) sendMedia(ctx context.Context, client *slackapi.Client, input model.SendInput, thread string) model.SendResult {
	if input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID {
		return common.Reject("invalid_media")
	}
	file, err := c.upload(ctx, client, *input.Media)
	if err != nil {
		return failure(err, true)
	}
	files := []slackapi.FileSummary{file}
	if input.Preview != nil {
		preview, err := c.upload(ctx, client, *input.Preview)
		if err != nil {
			return failure(err, true)
		}
		files = append(files, preview)
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0)
	}
	// Transfer failures are safe to retry before completion; this completion
	// shares the file to a channel and may have published despite a lost response.
	response, err := client.CompleteUploadExternalContext(ctx, slackapi.CompleteUploadExternalParameters{Files: files, Channel: input.Target.ChatID, ThreadTimestamp: thread, InitialComment: text.Slack(input.Chunk.Text)})
	if err != nil {
		return failure(err, false)
	}
	if !validateCompletion(response, files) {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_invalid_completion"}
	}
	return common.Sent(file.ID)
}

func (c *Channel) sendRich(ctx context.Context, client *slackapi.Client, input model.SendInput, thread string) model.SendResult {
	var blocks []slackapi.Block
	var fallback strings.Builder
	image := 0
	for _, part := range input.Chunk.RichText {
		if part.Type == "text" {
			parts, err := text.SplitByRendered(part.Text, 3000, model.Codepoint, text.Slack)
			if err != nil {
				return common.Reject("rich_text_limit_exceeded")
			}
			for _, value := range parts {
				blocks = append(blocks, slackapi.NewSectionBlock(slackapi.NewTextBlockObject("mrkdwn", text.Slack(value), false, false), nil, nil))
			}
			fallback.WriteString(text.Slack(part.Text))
			continue
		}
		if part.Media == nil || image >= len(input.RichMedia) {
			return common.Reject("invalid_media")
		}
		block, result := c.richImage(ctx, client, input.RichMedia[image], part.Label)
		if result != nil {
			return *result
		}
		image++
		blocks = append(blocks, block)
		fallback.WriteString(slackutilsx.EscapeMessage(part.Label))
	}
	if len(blocks) > 50 {
		return common.Reject("rich_message_limit_exceeded")
	}
	return c.post(ctx, client, input.Target.ChatID, thread, fallback.String(), blocks)
}

func (c *Channel) richImage(ctx context.Context, client *slackapi.Client, media model.StoredMedia, label string) (slackapi.Block, *model.SendResult) {
	if label == "" {
		label = media.Reference.FileName
	}
	if text.Length(label, model.Codepoint) > 2000 {
		result := common.Reject("rich_image_label_limit_exceeded")
		return nil, &result
	}
	file, err := c.upload(ctx, client, media)
	if err != nil {
		result := failure(err, true)
		return nil, &result
	}
	files := []slackapi.FileSummary{file}
	// Complete privately first. Slack explicitly supports unshared private
	// files in image blocks, so this step cannot publish a channel message:
	// https://slack.com/blog/developers/uploading-private-images-blockkit
	response, err := client.CompleteUploadExternalContext(ctx, slackapi.CompleteUploadExternalParameters{Files: files})
	if err != nil {
		result := failure(err, true)
		return nil, &result
	}
	if !validateCompletion(response, files) {
		result := common.Retry("native_invalid_completion", time.Second)
		return nil, &result
	}
	return slackapi.NewImageBlockSlackFile(&slackapi.SlackFileObject{ID: file.ID}, label, "", nil), nil
}
