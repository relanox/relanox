package matrix

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	client, err := c.client(ctx)
	if err != nil {
		return failure(err, true, false), nil
	}
	if !c.validTarget(input.Target, client) {
		return common.Reject("target_identity_changed"), nil
	}
	limits := richLimits
	limits.MaxImageBytes = common.MediaLimit(c.host)
	if code := common.ValidateRich(input, limits, model.UTF8, common.MediaLimit(c.host)); code != "" {
		return common.Reject(code), nil
	}
	if len(text.Plain(input.Chunk.Text))+len(text.Matrix(input.Chunk.Text)) > 16000 {
		return common.Reject("text_limit_exceeded"), nil
	}
	if input.Chunk.IdempotencyKey == "" {
		return common.Reject("missing_idempotency_key"), nil
	}
	if result := checkEncryption(ctx, client, input.Target.ChatID); result != nil {
		return *result, nil
	}
	content, err := c.content(ctx, client, input)
	if err != nil {
		if err.Error() == "invalid_media" {
			return common.Reject("invalid_media"), nil
		}
		return failure(err, true, false), nil
	}
	content.RelatesTo = relation(input)
	if len(common.Data(content)) > 60000 {
		return common.Reject("rich_message_limit_exceeded"), nil
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	response, err := client.SendMessageEvent(quiet(ctx), id.RoomID(input.Target.ChatID), event.EventMessage, content, mautrix.ReqSendEvent{TransactionID: input.Chunk.IdempotencyKey, DontEncrypt: true})
	if err != nil {
		return failure(err, false, client.DeviceID != ""), nil
	}
	if response == nil || !platformID(string(response.EventID)) {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_invalid_response"}, nil
	}
	return common.Sent(string(response.EventID)), nil
}

func checkEncryption(ctx context.Context, client *mautrix.Client, room string) *model.SendResult {
	var content event.EncryptionEventContent
	err := client.StateEvent(quiet(ctx), id.RoomID(room), event.StateEncryption, "", &content)
	if err == nil {
		result := common.Reject("encrypted_unsupported")
		return &result
	}
	if errors.Is(err, mautrix.MNotFound) {
		return nil
	}
	result := failure(err, true, false)
	var native mautrix.HTTPError
	if errors.As(err, &native) && native.IsStatus(404) {
		result = common.Retry("encryption_check_failed", time.Second)
	}
	return &result
}

func relation(input model.SendInput) *event.RelatesTo {
	var value *event.RelatesTo
	if input.Target.ThreadID != "" {
		value = &event.RelatesTo{Type: event.RelThread, EventID: id.EventID(input.Target.ThreadID), IsFallingBack: true}
	}
	if input.Reply != nil && input.Target.ReplyToID != "" {
		if value == nil {
			value = &event.RelatesTo{}
		}
		value.InReplyTo = &event.InReplyTo{EventID: id.EventID(input.Target.ReplyToID)}
		value.IsFallingBack = false
	}
	return value
}

func failure(err error, preparing, idempotent bool) model.SendResult {
	var native mautrix.HTTPError
	if errors.As(err, &native) && native.Response != nil {
		status := native.Response.StatusCode
		if status == 429 || errors.Is(err, mautrix.MLimitExceeded) {
			after := common.RetryAfter(native.Response.Header)
			if after == 0 && native.RespError != nil {
				if ms, ok := native.RespError.ExtraData["retry_after_ms"].(float64); ok && ms > 0 {
					after = time.Duration(ms * float64(time.Millisecond))
				}
			}
			return common.Retry("rate_limited", after)
		}
		if status == 401 {
			return common.Retry("oauth_token_rejected", 0)
		}
		if status >= 400 && status < 500 && status != http.StatusRequestTimeout {
			return common.Reject("platform_request_rejected")
		}
	}
	if preparing {
		return common.Retry("native_preparation_failed", time.Second)
	}
	if idempotent {
		return common.Retry("native_transaction_retained", time.Second)
	}
	return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}
}
