package qq

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/transport"
)

// Wire contracts follow the current official SDK, @tencent-connect/qqbot-nodejs
// 1.0.5 (MIT), protocol/api/{token,api-client,messages,media}.ts and
// protocol/types.ts. The old Go SDK omits current msg_idx/chunked contracts.
// https://github.com/tencent-connect/qqbot-nodejs

func (c *Channel) token(ctx context.Context) (string, error) {
	secret, err := c.options.Secret(c.config.ClientSecret)
	if err != nil {
		return "", err
	}
	return c.tokens.Get(ctx, c.config.AppID+"\x00"+secret, func(ctx context.Context) (string, time.Time, error) {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		var response struct {
			AccessToken string      `json:"access_token"`
			ExpiresIn   json.Number `json:"expires_in"`
		}
		body := struct {
			AppID        string `json:"appId"`
			ClientSecret string `json:"clientSecret"`
		}{c.config.AppID, secret}
		if err := common.JSON(ctx, c.options.HTTPClient, http.MethodPost, "https://bots.qq.com/app/getAppAccessToken", nil, body, &response); err != nil {
			return "", time.Time{}, err
		}
		seconds := int64(7200)
		if response.ExpiresIn != "" {
			seconds, err = strconv.ParseInt(string(response.ExpiresIn), 10, 64)
		}
		if err != nil || seconds <= 0 || seconds > 365*24*3600 || response.AccessToken == "" {
			return "", time.Time{}, errors.New("invalid_qq_token_response")
		}
		skew := min(5*time.Minute, time.Duration(seconds)*time.Second/10)
		return response.AccessToken, time.Now().Add(time.Duration(seconds)*time.Second - skew), nil
	})
}

type apiError struct{ code int }

func (e *apiError) Error() string { return "qq_native_error" }

type preparationError struct{ cause error }

func (e *preparationError) Error() string { return "qq_preparation_failed" }

func (e *preparationError) Unwrap() error { return e.cause }

func parseAPIError(raw []byte) error {
	var body struct {
		Code      int `json:"code"`
		ErrorCode int `json:"err_code"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return errors.New("native_invalid_response")
	}
	code := body.Code
	if code == 0 {
		code = body.ErrorCode
	}
	if code != 0 {
		return &apiError{code: code}
	}
	return nil
}

func (c *Channel) api(ctx context.Context, method, path string, input, output any) error {
	token, err := c.token(ctx)
	if err != nil {
		return &preparationError{cause: err}
	}
	timeout := 30 * time.Second
	if method == http.MethodPost && output != nil {
		timeout = 120 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var raw json.RawMessage
	err = common.JSON(ctx, c.options.HTTPClient, method, c.base()+path, http.Header{"Authorization": {"QQBot " + token}}, input, &raw)
	if err != nil {
		return c.nativeHTTPError(err)
	}
	if err = parseAPIError(raw); err != nil {
		return err
	}
	if output != nil && json.Unmarshal(raw, output) != nil {
		return errors.New("native_invalid_response")
	}
	return nil
}

func (c *Channel) nativeHTTPError(err error) error {
	var native *common.HTTPError
	if !errors.As(err, &native) {
		return err
	}
	if native.Status == 401 {
		c.tokens.Invalidate()
		return err
	}
	if business := parseAPIError(native.Body); business != nil {
		var typed *apiError
		if errors.As(business, &typed) {
			return typed
		}
	}
	return err
}

func (c *Channel) failure(err error, preparing bool) model.SendResult {
	var preparation *preparationError
	if errors.As(err, &preparation) {
		preparing = true
	}
	if errors.Is(err, transport.ErrUnsafeURL) {
		return common.Reject("invalid_upload_part_origin")
	}
	var native *apiError
	if errors.As(err, &native) {
		return businessFailure(native.code, preparing)
	}
	if common.Contains([]string{"missing_media", "unsupported_media_format", "media_too_large", "media_publication_unavailable", "invalid_publication_url", "rich_text_limit_exceeded", "qq_upload_daily_limit", "invalid_upload_plan", "invalid_upload_part_origin"}, err.Error()) {
		return common.Reject(err.Error())
	}
	return common.Failure(err, preparing)
}

func businessFailure(code int, preparing bool) model.SendResult {
	if code == 40054005 {
		return model.SendResult{Status: model.Unknown, ErrorCode: "qq_duplicate_effect"}
	}
	if code == 40093002 && preparing {
		return common.Reject("qq_upload_daily_limit")
	}
	if code == 40034100 || code == 50055001 || code == 50055006 {
		return common.Retry("qq_"+strconv.Itoa(code), time.Second)
	}
	if preparing && (code == 40093001 || code == 850027) {
		return common.Retry("qq_"+strconv.Itoa(code), time.Second)
	}
	return common.Reject("qq_" + strconv.Itoa(code))
}
