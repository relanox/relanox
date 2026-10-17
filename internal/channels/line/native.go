package line

import (
	"context"
	"net/http"
	"strings"

	sdk "github.com/line/line-bot-sdk-go/v8/linebot/messaging_api"
	"github.com/relanox/relanox/internal/channels/common"
)

func (c *Channel) nativeClient(ctx context.Context, headers http.Header) (*sdk.MessagingApiAPI, error) {
	client, err := sdk.NewMessagingApiAPI(strings.TrimPrefix(headers.Get("Authorization"), "Bearer "), sdk.WithHTTPClient(common.SDKHTTPClient(c.client, ctx, common.MaxJSONBytes)))
	if err != nil {
		return nil, err
	}
	return client.WithContext(ctx), nil
}

func nativeError(response *http.Response, err error) error {
	if err != nil && response != nil && response.StatusCode >= 300 {
		defer func() { _ = response.Body.Close() }()
		body, _ := common.ReadBounded(response.Body, 64*1024)
		return &common.HTTPError{Status: response.StatusCode, Header: response.Header, Body: body}
	}
	return err
}
