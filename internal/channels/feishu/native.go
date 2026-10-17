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

// The official Go SDK's core token envelope is top-level; its generated auth/v3
// envelope incorrectly nests data. Keep the verified core contract and typed
// IM request/response structs, with one context-aware HTTP attempt per send.
// github.com/larksuite/oapi-sdk-go/v3 v3.12.2 core/tokenmanager.go (MIT).
func (c *Channel) token(ctx context.Context) (string, error) {
	secret, err := c.options.Secret(c.config.AppSecret)
	if err != nil {
		return "", err
	}
	return c.tokens.Get(ctx, c.config.AppID+"\x00"+secret, func(ctx context.Context) (string, time.Time, error) {
		var response larkcore.TenantAccessTokenResp
		request := larkcore.SelfBuiltTenantAccessTokenReq{AppID: c.config.AppID, AppSecret: secret}
		if err := common.JSON(ctx, c.options.HTTPClient, http.MethodPost, c.base()+"/open-apis/auth/v3/tenant_access_token/internal", nil, request, &response); err != nil {
			return "", time.Time{}, err
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
	if err = common.JSON(ctx, c.options.HTTPClient, http.MethodGet, c.base()+"/open-apis/bot/v3/info", http.Header{"Authorization": {"Bearer " + token}}, nil, &response); err != nil {
		return "", err
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
	var request any
	endpoint := c.base() + "/open-apis/im/v1/messages?receive_id_type=chat_id"
	if replyID != "" {
		inThread := input.Target.ThreadID != ""
		request = larkim.ReplyMessageReqBody{Content: &content, MsgType: &kind, ReplyInThread: &inThread}
		endpoint = c.base() + "/open-apis/im/v1/messages/" + escapedID(replyID) + "/reply"
	} else {
		request = larkim.CreateMessageReqBody{ReceiveId: &input.Target.ChatID, Content: &content, MsgType: &kind}
	}
	var response larkim.CreateMessageResp
	if err = common.JSON(ctx, c.options.HTTPClient, http.MethodPost, endpoint, http.Header{"Authorization": {"Bearer " + token}}, request, &response); err != nil {
		return "", err
	}
	if response.Code != 0 {
		return "", &apiError{code: response.Code}
	}
	if response.Data == nil || response.Data.MessageId == nil || *response.Data.MessageId == "" {
		return "", errors.New("missing_message_receipt")
	}
	return *response.Data.MessageId, nil
}
