package whatsapp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

type format struct {
	limit int64
	mimes []string
}

var formats = map[model.MediaKind]format{
	model.Image: {5_000_000, []string{"image/jpeg", "image/png"}},
	model.Audio: {16_000_000, []string{"audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"}},
	model.Video: {16_000_000, []string{"video/mp4", "video/3gpp"}},
	model.File:  {100_000_000, []string{"text/plain", "application/pdf", "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation"}},
}

func selected(m message) (*media, model.MediaKind) {
	switch m.Type {
	case "image":
		return m.Image, model.Image
	case "audio":
		return m.Audio, model.Audio
	case "video":
		return m.Video, model.Video
	case "document":
		return m.Document, model.File
	}
	return nil, ""
}

func (c *Channel) receiveMedia(ctx context.Context, m message) (string, []model.MediaUpload, error) {
	if m.Type == "text" && m.Text != nil {
		return m.Text.Body, nil, nil
	}
	payload, kind := selected(m)
	if kind == "" {
		return "", nil, nil
	}
	if payload == nil || !platformID(payload.ID) {
		return "", nil, errors.New("invalid_native_media")
	}
	headers, err := c.headers()
	if err != nil {
		return "", nil, err
	}
	var metadata struct {
		ID   string          `json:"id"`
		URL  string          `json:"url"`
		MIME string          `json:"mime_type"`
		Size json.RawMessage `json:"file_size"`
	}
	if err = common.JSON(ctx, c.client, http.MethodGet, endpoint(payload.ID, "")+"?phone_number_id="+url.QueryEscape(c.config.PhoneNumberID), headers, nil, &metadata); err != nil {
		return "", nil, err
	}
	origin := common.Origin(metadata.URL)
	if metadata.ID != payload.ID || !common.Contains([]string{apiBase, "https://lookaside.fbsbx.com"}, origin) {
		return "", nil, errors.New("untrusted_media_origin")
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(metadata.MIME, ";")[0]))
	format := formats[kind]
	if !common.Contains(format.mimes, mimeType) {
		return "", nil, errors.New("unsupported_media")
	}
	size, err := strconv.ParseInt(strings.Trim(string(metadata.Size), `"`), 10, 64)
	if err != nil || size < 0 {
		return "", nil, errors.New("invalid_media_size")
	}
	maximum := min(format.limit, common.MediaLimit(c.host))
	if size > maximum {
		return "", nil, errors.New("media_too_large")
	}
	data, err := common.Download(ctx, metadata.URL, common.DownloadOptions{MaxBytes: maximum, TrustedOrigins: []string{apiBase, "https://lookaside.fbsbx.com"}, Headers: headers, TLSClientConfig: c.options.TLSClientConfig})
	if err != nil {
		return "", nil, err
	}
	name := payload.Filename
	if name == "" {
		name = data.FileName
	}
	return payload.Caption, []model.MediaUpload{{Kind: kind, MIMEType: mimeType, FileName: name, Data: data.Data}}, nil
}

func failure(err error, preparing bool) model.SendResult {
	var native *common.HTTPError
	if errors.As(err, &native) {
		var payload struct {
			Error struct {
				Code int `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(native.Body, &payload)
		limited := native.Status == 429 || native.Status == 400 && (payload.Error.Code == 4 || payload.Error.Code == 80007 || payload.Error.Code == 130429 || payload.Error.Code == 131056)
		if limited {
			return common.Retry("rate_limited", max(common.RetryAfter(native.Header), time.Second))
		}
		if native.Status == 408 {
			return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}
		}
	}
	return common.Failure(err, preparing)
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	if !c.validTarget(input.Target) {
		return common.Reject("invalid_target"), nil
	}
	until, err := c.window(ctx, input.Target.ChatID)
	if err != nil {
		return model.SendResult{}, err
	}
	if time.Now().UnixMilli() >= until {
		return common.Reject("customer_window_expired"), nil
	}
	if len(input.Chunk.RichText) > 0 {
		return common.Reject("rich_text_unsupported"), nil
	}
	headers, err := c.headers()
	if err != nil {
		return failure(err, true), nil
	}
	body := map[string]any{"messaging_product": "whatsapp", "recipient_type": "individual", "to": input.Target.ChatID}
	if input.Reply != nil && platformID(input.Target.ReplyToID) {
		body["context"] = map[string]string{"message_id": input.Target.ReplyToID}
	}
	if input.Chunk.Media == nil {
		value := markdown(input.Chunk.Text)
		if text.Length(value, model.UTF16) > 4096 {
			return common.Reject("text_limit_exceeded"), nil
		}
		body["type"] = "text"
		body["text"] = map[string]any{"body": value, "preview_url": false}
	} else {
		media, kind, outcome := c.upload(ctx, input, headers)
		if outcome != nil {
			return *outcome, nil
		}
		body["type"] = kind
		body[kind] = media
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	var result struct {
		Product  string `json:"messaging_product"`
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err = common.JSON(ctx, c.client, http.MethodPost, endpoint(c.config.PhoneNumberID, "/messages"), headers, body, &result); err != nil {
		return failure(err, false), nil
	}
	if result.Product != "whatsapp" || len(result.Messages) == 0 || !platformID(result.Messages[0].ID) {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_invalid_response"}, nil
	}
	return common.Sent(result.Messages[0].ID), nil
}

func (c *Channel) upload(ctx context.Context, input model.SendInput, headers http.Header) (map[string]string, string, *model.SendResult) {
	if input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID || input.Media.Reference.Size != int64(len(input.Media.Data)) {
		result := common.Reject("invalid_media")
		return nil, "", &result
	}
	ref := input.Media.Reference
	format, ok := formats[ref.Kind]
	if !ok || !common.Contains(format.mimes, ref.MIMEType) {
		result := common.Reject("media_format_unsupported")
		return nil, "", &result
	}
	if int64(len(input.Media.Data)) > min(format.limit, common.MediaLimit(c.host)) {
		result := common.Reject("media_too_large")
		return nil, "", &result
	}
	caption := markdown(input.Chunk.Text)
	if text.Length(caption, model.UTF16) > 1024 || (ref.Kind == model.Audio && caption != "") {
		result := common.Reject("invalid_media_caption")
		return nil, "", &result
	}
	var uploaded struct {
		ID string `json:"id"`
	}
	err := common.Multipart(ctx, c.client, endpoint(c.config.PhoneNumberID, "/media"), headers, map[string]string{"messaging_product": "whatsapp", "type": ref.MIMEType}, "file", ref.FileName, input.Media.Data, &uploaded)
	if err != nil {
		result := failure(err, true)
		return nil, "", &result
	}
	if !platformID(uploaded.ID) {
		result := common.Retry("media_upload_response_invalid", 0)
		return nil, "", &result
	}
	kind := string(ref.Kind)
	if ref.Kind == model.File {
		kind = "document"
	}
	media := map[string]string{"id": uploaded.ID}
	if caption != "" {
		media["caption"] = caption
	}
	if ref.Kind == model.File {
		media["filename"] = ref.FileName
	}
	return media, kind, nil
}
