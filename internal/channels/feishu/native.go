package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// The generated auth/v3 response incorrectly nests the token under data.
// Use the SDK core request client with its verified top-level token envelope.
// github.com/larksuite/oapi-sdk-go/v3 v3.12.2 core/tokenmanager.go (MIT).
func (c *Channel) token(ctx context.Context) (string, error) {
	secret, err := c.options.Secret(c.config.AppSecret)
	if err != nil {
		return "", err
	}
	return c.tokens.Get(ctx, c.config.AppID+"\x00"+secret, func(ctx context.Context) (string, time.Time, error) {
		config := c.sdkConfig(ctx, common.MaxJSONBytes)
		config.AppSecret = secret
		request := &larkcore.ApiReq{HttpMethod: http.MethodPost, ApiPath: "/open-apis/auth/v3/tenant_access_token/internal", Body: larkcore.SelfBuiltTenantAccessTokenReq{AppID: c.config.AppID, AppSecret: secret}}
		raw, err := larkcore.Request(ctx, request, config)
		if err := nativeError(raw, err); err != nil {
			return "", time.Time{}, err
		}
		var response larkcore.TenantAccessTokenResp
		if json.Unmarshal(raw.RawBody, &response) != nil {
			return "", time.Time{}, errors.New("native_invalid_response")
		}
		if response.Code != 0 {
			return "", time.Time{}, &apiError{code: response.Code}
		}
		if response.TenantAccessToken == "" || response.Expire <= 0 {
			return "", time.Time{}, errors.New("missing_tenant_token")
		}
		skew := min(30*time.Second, time.Duration(response.Expire)*time.Second/10)
		return response.TenantAccessToken, time.Now().Add(time.Duration(response.Expire)*time.Second - skew), nil
	})
}

type apiError struct{ code int }

func (e *apiError) Error() string { return "feishu_native_error" }

func (c *Channel) failure(err error, preparing bool) model.SendResult {
	var native *apiError
	if errors.As(err, &native) {
		if native.code == 99991663 {
			c.tokens.Invalidate()
			return common.Retry("feishu_token_invalid", 0)
		}
		return common.Reject("feishu_api_error")
	}
	var httpError *common.HTTPError
	if errors.As(err, &httpError) && (httpError.Status == 400 || httpError.Status == 401) {
		var body struct {
			Code int `json:"code"`
		}
		if json.Unmarshal(httpError.Body, &body) == nil && body.Code == 99991663 {
			c.tokens.Invalidate()
			return common.Retry("feishu_token_invalid", 0)
		}
	}
	return common.Failure(err, preparing)
}

func (c *Channel) ensureIdentity(ctx context.Context) (string, error) {
	c.mu.Lock()
	botID := c.botID
	c.mu.Unlock()
	if botID != "" {
		return botID, nil
	}
	select {
	case c.identityGate <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-c.identityGate }()
	c.mu.Lock()
	botID = c.botID
	c.mu.Unlock()
	if botID != "" {
		return botID, nil
	}
	token, err := c.token(ctx)
	if err != nil {
		return "", err
	}
	var response struct {
		Code int `json:"code"`
		Bot  struct {
			OpenID string `json:"open_id"`
		} `json:"bot"`
	}
	raw, err := larkcore.Request(ctx, &larkcore.ApiReq{HttpMethod: http.MethodGet, ApiPath: "/open-apis/bot/v3/info", SupportedAccessTokenTypes: []larkcore.AccessTokenType{larkcore.AccessTokenTypeTenant}}, c.sdkConfig(ctx, common.MaxJSONBytes), larkcore.WithTenantAccessToken(token))
	if err := nativeError(raw, err); err != nil {
		return "", err
	}
	if json.Unmarshal(raw.RawBody, &response) != nil {
		return "", errors.New("native_invalid_response")
	}
	if response.Code != 0 {
		return "", &apiError{code: response.Code}
	}
	if response.Bot.OpenID == "" {
		return "", errors.New("missing_bot_identity")
	}
	c.mu.Lock()
	c.botID = response.Bot.OpenID
	c.mu.Unlock()
	return response.Bot.OpenID, nil
}

func (c *Channel) sendMessage(ctx context.Context, input model.SendInput, content, kind, replyID string) (string, error) {
	token, err := c.token(ctx)
	if err != nil {
		return "", err
	}
	client := c.imClient(ctx, common.MaxJSONBytes)
	if replyID != "" {
		inThread := input.Target.ThreadID != ""
		body := &larkim.ReplyMessageReqBody{Content: &content, MsgType: &kind, ReplyInThread: &inThread}
		request := larkim.NewReplyMessageReqBuilder().MessageId(replyID).Body(body).Build()
		response, err := client.Message.Reply(ctx, request, larkcore.WithTenantAccessToken(token))
		if err != nil {
			return "", err
		}
		if err := nativeError(response.ApiResp, nil); err != nil {
			return "", err
		}
		if response.Code != 0 {
			return "", &apiError{code: response.Code}
		}
		if response.Data == nil {
			return "", errors.New("missing_message_receipt")
		}
		return messageReceipt(response.Data.MessageId)
	}
	body := &larkim.CreateMessageReqBody{ReceiveId: &input.Target.ChatID, Content: &content, MsgType: &kind}
	request := larkim.NewCreateMessageReqBuilder().ReceiveIdType("chat_id").Body(body).Build()
	response, err := client.Message.Create(ctx, request, larkcore.WithTenantAccessToken(token))
	if err != nil {
		return "", err
	}
	if err := nativeError(response.ApiResp, nil); err != nil {
		return "", err
	}
	if response.Code != 0 {
		return "", &apiError{code: response.Code}
	}
	if response.Data == nil {
		return "", errors.New("missing_message_receipt")
	}
	return messageReceipt(response.Data.MessageId)
}

func messageReceipt(id *string) (string, error) {
	if id == nil || *id == "" {
		return "", errors.New("missing_message_receipt")
	}
	return *id, nil
}
