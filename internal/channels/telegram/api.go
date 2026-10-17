package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

type response struct {
	OK         bool            `json:"ok"`
	Result     json.RawMessage `json:"result,omitempty"`
	Code       int             `json:"error_code,omitempty"`
	Parameters struct {
		RetryAfter float64 `json:"retry_after,omitempty"`
	} `json:"parameters,omitempty"`
}

type apiError struct {
	code  int
	retry time.Duration
}

func (e *apiError) Error() string { return "telegram_api_rejected" }

func (c *Channel) endpoint(method string) (string, error) {
	token, err := c.options.Secret(c.config.BotToken)
	if err != nil {
		return "", err
	}
	if _, err = c.identity(); err != nil {
		return "", err
	}
	if strings.ContainsAny(token, "/?#\r\n") {
		return "", errors.New("invalid_bot_token")
	}
	return c.config.APIBaseURL + "/bot" + token + "/" + method, nil
}

func unpack(result response, out any) error {
	if !result.OK {
		return &apiError{code: result.Code, retry: time.Duration(result.Parameters.RetryAfter * float64(time.Second))}
	}
	if json.Unmarshal(result.Result, out) != nil {
		return errors.New("native_invalid_response")
	}
	return nil
}

func (c *Channel) api(ctx context.Context, method string, input, output any) error {
	endpoint, err := c.endpoint(method)
	if err != nil {
		return err
	}
	var result response
	err = common.JSON(ctx, c.client, http.MethodPost, endpoint, nil, input, &result)
	if err != nil {
		var native *common.HTTPError
		if errors.As(err, &native) && json.Unmarshal(native.Body, &result) == nil && !result.OK && result.Code != 0 {
			return unpack(result, output)
		}
		return err
	}
	return unpack(result, output)
}

var safeFile = regexp.MustCompile(`^[A-Za-z0-9_./-]+$`)

func validFilePath(value string) bool {
	if !safeFile.MatchString(value) || strings.HasPrefix(value, "/") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func selected(m message) (*file, model.MediaKind, string) {
	if len(m.Photos) > 0 {
		return &m.Photos[len(m.Photos)-1], model.Image, "image/jpeg"
	}
	for _, v := range []struct {
		f    *file
		k    model.MediaKind
		mime string
	}{{m.Audio, model.Audio, "audio/mpeg"}, {m.Voice, model.Audio, "audio/ogg"}, {m.Video, model.Video, "video/mp4"}, {m.Animation, model.Image, "image/gif"}, {m.VideoNote, model.Video, "video/mp4"}, {m.Document, model.File, "application/octet-stream"}} {
		if v.f != nil {
			return v.f, v.k, v.mime
		}
	}
	return nil, "", ""
}

func (c *Channel) download(ctx context.Context, m message) ([]model.MediaUpload, error) {
	f, kind, mimeType := selected(m)
	if f == nil {
		return nil, nil
	}
	maximum := min(common.MediaLimit(c.host), 20*1024*1024)
	if f.ID == "" || f.Size < 0 || f.Size > maximum {
		return nil, errors.New("media_too_large")
	}
	var result struct {
		Path string `json:"file_path"`
		Size int64  `json:"file_size"`
	}
	if err := c.api(ctx, "getFile", map[string]string{"file_id": f.ID}, &result); err != nil {
		return nil, err
	}
	if !validFilePath(result.Path) || result.Size > maximum {
		return nil, errors.New("invalid_telegram_file")
	}
	token, err := c.options.Secret(c.config.BotToken)
	if err != nil {
		return nil, err
	}
	data, err := common.Download(ctx, c.config.APIBaseURL+"/file/bot"+token+"/"+result.Path, common.DownloadOptions{MaxBytes: maximum, TrustedOrigins: []string{common.Origin(c.config.APIBaseURL)}, AllowInsecureLoopback: c.config.AllowInsecureLoopback, TLSClientConfig: c.options.TLSClientConfig})
	if err != nil {
		return nil, err
	}
	if f.MIME != "" {
		mimeType = f.MIME
	}
	name := f.Name
	if name == "" {
		name = path.Base(result.Path)
	}
	upload := model.MediaUpload{Kind: kind, MIMEType: mimeType, FileName: name, Data: data.Data}
	if f.Duration > 0 && f.Duration <= float64(math.MaxInt64/1000) {
		duration := int64(f.Duration * 1000)
		upload.DurationMS = &duration
	}
	return []model.MediaUpload{upload}, nil
}

func failure(err error, preparing bool) model.SendResult {
	var native *apiError
	if errors.As(err, &native) {
		if native.code == 429 {
			return common.Retry("rate_limited", native.retry)
		}
		if native.code >= 400 && native.code < 500 && native.code != 408 {
			return common.Reject("platform_request_rejected")
		}
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}
	}
	var httpError *common.HTTPError
	if errors.As(err, &httpError) && httpError.Status == 408 {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}
	}
	return common.Failure(err, preparing)
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	identity, err := c.identity()
	if err != nil {
		return failure(err, true), nil
	}
	if !c.validTarget(input.Target, identity) {
		return common.Reject("invalid_target"), nil
	}
	if input.Target.ThreadID != "" && !positiveID.MatchString(input.Target.ThreadID) {
		return common.Reject("invalid_thread"), nil
	}
	if len(input.Chunk.RichText) > 0 {
		return common.Reject("rich_text_unsupported"), nil
	}
	if input.Chunk.Media != nil && (input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID || int64(len(input.Media.Data)) != input.Media.Reference.Size) {
		return common.Reject("invalid_media"), nil
	}
	if err = ctx.Err(); err != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	fields := map[string]any{"chat_id": input.Target.ChatID, "link_preview_options": map[string]bool{"is_disabled": true}}
	if input.Target.ThreadID != "" {
		fields["message_thread_id"] = json.Number(input.Target.ThreadID)
	}
	if input.Reply != nil && positiveID.MatchString(input.Target.ReplyToID) {
		fields["reply_parameters"] = map[string]any{"message_id": json.Number(input.Target.ReplyToID), "allow_sending_without_reply": true}
	}
	limit := 4096
	if input.Chunk.Media != nil {
		limit = 1024
	}
	rendered := text.Telegram(input.Chunk.Text)
	if text.Length(rendered.Text, model.Codepoint) > limit {
		return common.Reject("text_limit_exceeded"), nil
	}
	var sent struct {
		ID json.Number `json:"message_id"`
	}
	if input.Chunk.Media == nil {
		fields["text"] = rendered.Text
		fields["entities"] = rendered.Entities
		err = c.api(ctx, "sendMessage", fields, &sent)
	} else {
		err = c.sendMedia(ctx, input, fields, rendered, &sent)
	}
	if err != nil {
		return failure(err, false), nil
	}
	if !positiveID.MatchString(sent.ID.String()) {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_invalid_response"}, nil
	}
	return common.Sent(sent.ID.String()), nil
}

func (c *Channel) validTarget(input model.ReplyTarget, identity targetData) bool {
	var target targetData
	return input.Channel == model.Telegram && input.AccountID == c.account.ID && integerID.MatchString(input.ChatID) && json.Unmarshal(input.Data, &target) == nil && target == identity
}

func mediaMethod(ref model.MediaReference) (string, string, int64) {
	switch ref.Kind {
	case model.Image:
		if ref.MIMEType == "image/gif" {
			return "sendAnimation", "animation", 50 * 1024 * 1024
		}
		return "sendPhoto", "photo", 10 * 1024 * 1024
	case model.Audio:
		if common.Contains([]string{"audio/ogg", "audio/opus"}, ref.MIMEType) {
			return "sendVoice", "voice", 50 * 1024 * 1024
		}
		if common.Contains([]string{"audio/mpeg", "audio/mp4", "audio/x-m4a"}, ref.MIMEType) {
			return "sendAudio", "audio", 50 * 1024 * 1024
		}
	case model.Video:
		return "sendVideo", "video", 50 * 1024 * 1024
	}
	return "sendDocument", "document", 50 * 1024 * 1024
}

func (c *Channel) sendMedia(ctx context.Context, input model.SendInput, fields map[string]any, caption text.TelegramText, out any) error {
	if input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID || int64(len(input.Media.Data)) != input.Media.Reference.Size {
		return &apiError{code: 400}
	}
	method, field, maximum := mediaMethod(input.Media.Reference)
	if int64(len(input.Media.Data)) > min(maximum, common.MediaLimit(c.host)) {
		return &apiError{code: 400}
	}
	fields["caption"] = caption.Text
	fields["caption_entities"] = caption.Entities
	if duration := input.Media.Reference.DurationMS; duration != nil && *duration > 0 {
		fields["duration"] = (*duration + 999) / 1000
	}
	form := make(map[string]string, len(fields))
	for key, value := range fields {
		switch v := value.(type) {
		case string:
			form[key] = v
		case int64:
			form[key] = strconv.FormatInt(v, 10)
		default:
			form[key] = string(common.Data(value))
		}
	}
	endpoint, err := c.endpoint(method)
	if err != nil {
		return err
	}
	var result response
	if err = common.Multipart(ctx, c.client, endpoint, nil, form, field, input.Media.Reference.FileName, input.Media.Data, &result); err != nil {
		var native *common.HTTPError
		if errors.As(err, &native) && json.Unmarshal(native.Body, &result) == nil && !result.OK && result.Code != 0 {
			return unpack(result, out)
		}
		return err
	}
	return unpack(result, out)
}
