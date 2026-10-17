package wechat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	ilink "github.com/openilink/openilink-sdk-go"
	"github.com/relanox/relanox/internal/channels/common"
)

func (c *Client) sdk(ctx context.Context) (*ilink.Client, error) {
	if c.Token == nil {
		return nil, errors.New("missing_bot_token")
	}
	token := c.Token()
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("missing_bot_token")
	}
	client := ilinkHTTP{client: common.SDKHTTPClient(c.httpClient(), ctx, common.MaxJSONBytes)}
	return ilink.NewClient(token, ilink.WithBaseURL(c.APIBase), ilink.WithCDNBaseURL(c.CDNBase), ilink.WithVersion("0.1.0"), ilink.WithHTTPClient(client)), nil
}

type ilinkHTTP struct{ client *http.Client }

func (c ilinkHTTP) Do(request *http.Request) (*http.Response, error) {
	response, err := c.client.Do(request)
	if err != nil {
		return nil, err
	}
	// SendMessage checks only HTTP status in the SDK. Keep the native ret and
	// errcode check before it can treat a rejected message as delivered.
	var raw json.RawMessage
	if err = readJSON(response, &raw); err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(raw))
	return response, nil
}

func (c *Client) send(ctx context.Context, message *ilink.WeixinMessage) error {
	client, err := c.sdk(ctx)
	if err != nil {
		return err
	}
	return client.SendMessage(ctx, &ilink.SendMessageReq{Msg: message})
}
