package signal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

type rpcResponse struct {
	Version string          `json:"jsonrpc"`
	ID      string          `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

func (c *Channel) rpc(ctx context.Context, id, method string, params map[string]any, maximum int64) (json.RawMessage, error) {
	headers, err := c.headers()
	if err != nil {
		return nil, err
	}
	params["account"] = c.config.Account
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.config.ServiceURL+"/api/v1/rpc", bytes.NewReader(common.Data(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})))
	if err != nil {
		return nil, err
	}
	request.Header = headers
	request.Header.Set("Content-Type", "application/json")
	raw, _, err := common.Do(c.client, request, maximum)
	if err != nil {
		return nil, err
	}
	var response rpcResponse
	if json.Unmarshal(raw, &response) != nil || response.Version != "2.0" || response.ID != id {
		return nil, errors.New("rpc_response_mismatch")
	}
	if len(response.Error) > 0 && string(response.Error) != "null" {
		return nil, errors.New("rpc_operation_error")
	}
	if len(response.Result) == 0 || string(response.Result) == "null" {
		return nil, errors.New("rpc_missing_result")
	}
	return response.Result, nil
}

func (c *Channel) receiveAttachments(ctx context.Context, attachments []attachment, sender, groupID string) ([]model.MediaUpload, error) {
	var uploads []model.MediaUpload
	maximum := common.MediaLimit(c.host)
	for _, attachment := range attachments {
		if attachment.ID == nil || *attachment.ID == "" {
			return nil, errors.New("attachment_unavailable")
		}
		if attachment.Size != nil && (*attachment.Size < 0 || *attachment.Size > maximum) {
			return nil, errors.New("media_too_large")
		}
		params := map[string]any{"id": *attachment.ID}
		if groupID != "" {
			params["groupId"] = groupID
		} else {
			params["recipient"] = sender
		}
		encodedMaximum := (maximum + 2) / 3 * 4
		raw, err := c.rpc(ctx, common.RandomID(), "getAttachment", params, encodedMaximum+16*1024)
		if err != nil {
			return nil, err
		}
		var result struct {
			Data string `json:"data"`
		}
		if json.Unmarshal(raw, &result) != nil {
			return nil, errors.New("invalid_attachment_response")
		}
		if int64(len(result.Data)) > encodedMaximum {
			return nil, errors.New("media_too_large")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(result.Data)
		if err != nil {
			return nil, errors.New("invalid_attachment_encoding")
		}
		if len(data) == 0 || int64(len(data)) > maximum {
			return nil, errors.New("media_too_large")
		}
		mimeType := strings.ToLower(strings.TrimSpace(strings.Split(attachment.ContentType, ";")[0]))
		if _, _, err = mime.ParseMediaType(mimeType); err != nil {
			return nil, errors.New("invalid_attachment_mime")
		}
		filename := "attachment.bin"
		if attachment.Filename != nil && *attachment.Filename != "" {
			filename = *attachment.Filename
		}
		uploads = append(uploads, model.MediaUpload{Kind: common.MediaKind(mimeType), MIMEType: mimeType, FileName: filename, Data: data})
	}
	return uploads, nil
}

type rendered struct {
	Message string
	Styles  []string
}

func markdown(value string) rendered {
	var result rendered
	offset := 0
	for _, run := range text.Runs(value) {
		length := text.Length(run.Text, model.UTF16)
		for _, style := range styles(run) {
			result.Styles = append(result.Styles, fmt.Sprintf("%d:%d:%s", offset, length, style))
		}
		result.Message += run.Text
		offset += length
		if run.Href != "" && run.Href != run.Text {
			link := " (" + run.Href + ")"
			result.Message += link
			offset += text.Length(link, model.UTF16)
		}
	}
	return result
}

func styles(run text.Run) []string {
	if run.Code || run.Pre {
		return []string{"MONOSPACE"}
	}
	var result []string
	for _, style := range []struct {
		enabled bool
		name    string
	}{{run.Bold, "BOLD"}, {run.Italic, "ITALIC"}, {run.Strike, "STRIKETHROUGH"}} {
		if style.enabled {
			result = append(result, style.name)
		}
	}
	return result
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	target, ok := c.validTarget(input.Target)
	if !ok {
		return common.Reject("target_identity_changed"), nil
	}
	if len(input.Chunk.RichText) > 0 {
		return common.Reject("rich_text_unsupported"), nil
	}
	rendered := markdown(input.Chunk.Text)
	if len(rendered.Message) > 16000 {
		return common.Reject("text_limit_exceeded"), nil
	}
	params := map[string]any{"message": rendered.Message}
	if len(rendered.Styles) > 0 {
		params["textStyle"] = rendered.Styles
	}
	if target.Kind == "group" {
		params["groupId"] = target.GroupID
	} else {
		params["recipient"] = []string{target.Recipient}
	}
	if input.Reply != nil && target.Quote != nil {
		params["quoteTimestamp"] = target.Quote.Timestamp
		params["quoteAuthor"] = target.Quote.Author
		params["quoteMessage"] = target.Quote.Text
	}
	if input.Chunk.Media != nil {
		attachment, code := c.outboundAttachment(input)
		if code != "" {
			return common.Reject(code), nil
		}
		params["attachments"] = []string{attachment}
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	raw, err := c.rpc(ctx, input.Chunk.IdempotencyKey, "send", params, common.MaxJSONBytes)
	if err != nil {
		var native *common.HTTPError
		if errors.As(err, &native) && native.Status == 408 {
			return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}, nil
		}
		return common.Failure(err, false), nil
	}
	var result struct {
		Timestamp *int64 `json:"timestamp"`
		Results   []struct {
			Type string `json:"type"`
		} `json:"results,omitempty"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Timestamp == nil || *result.Timestamp < 0 {
		return model.SendResult{Status: model.Unknown, ErrorCode: "rpc_invalid_result"}, nil
	}
	for _, recipient := range result.Results {
		if recipient.Type != "SUCCESS" {
			return model.SendResult{Status: model.Unknown, ErrorCode: "rpc_recipient_failure"}, nil
		}
	}
	return common.Sent(strconv.FormatInt(*result.Timestamp, 10)), nil
}

func (c *Channel) outboundAttachment(input model.SendInput) (string, string) {
	if input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID || int64(len(input.Media.Data)) != input.Media.Reference.Size {
		return "", "invalid_media"
	}
	if int64(len(input.Media.Data)) > common.MediaLimit(c.host) {
		return "", "media_too_large"
	}
	ref := input.Media.Reference
	if _, _, err := mime.ParseMediaType(ref.MIMEType); err != nil || strings.ContainsAny(ref.MIMEType, "\r\n;,") {
		return "", "invalid_media"
	}
	return "data:" + ref.MIMEType + ";filename=" + url.PathEscape(ref.FileName) + ";base64," + base64.StdEncoding.EncodeToString(input.Media.Data), ""
}
