package mattermost

import (
	"context"

	mm "github.com/mattermost/mattermost/server/public/model"
	"github.com/relanox/relanox/internal/channels/common"
)

func (c *Channel) nativeClient(ctx context.Context, token string, maximum int64) *mm.Client4 {
	client := mm.NewAPIv4Client(c.config.ServerURL)
	client.HTTPClient = common.SDKHTTPClient(c.client, ctx, maximum)
	client.SetToken(token)
	return client
}

func nativeError(response *mm.Response, err error) error {
	if err != nil && response != nil && response.StatusCode >= 300 {
		return &common.HTTPError{Status: response.StatusCode, Header: response.Header}
	}
	return err
}
