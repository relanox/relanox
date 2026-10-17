package discord

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/bwmarrin/discordgo"
	"github.com/relanox/relanox/internal/channels/common"
)

// RequestWithLockedBucket lets Core retain all waiting/retry decisions. A fresh
// initialized bucket avoids the SDK's uncancellable LockBucket sleep; both 429
// and 502 retries are explicitly disabled. The SDK owns request execution and
// native errors while the shared HTTP client bounds and cancels response reads.
func (c *Channel) nativeRequest(ctx context.Context, method, endpoint, contentType string, body []byte, output any) error {
	token, err := c.token()
	if err != nil {
		return err
	}
	client, err := discordgo.New("Bot " + token)
	if err != nil {
		return err
	}
	client.Client = common.SDKHTTPClient(c.http, ctx, common.MaxJSONBytes)
	client.LogLevel = -1
	bucket := client.Ratelimiter.GetBucket(endpoint)
	bucket.Lock()
	raw, err := client.RequestWithLockedBucket(method, endpoint, contentType, body, bucket, 0,
		discordgo.WithContext(ctx), discordgo.WithRestRetries(0), discordgo.WithRetryOnRatelimit(false))
	if err != nil {
		return nativeError(err)
	}
	if output != nil && json.Unmarshal(raw, output) != nil {
		return errors.New("native_invalid_response")
	}
	return nil
}

func nativeError(err error) error {
	var response *discordgo.RESTError
	if errors.As(err, &response) {
		return &common.HTTPError{Status: response.Response.StatusCode, Header: response.Response.Header, Body: response.ResponseBody}
	}
	var limited *discordgo.RateLimitError
	if errors.As(err, &limited) {
		return &common.HTTPError{Status: 429, Body: common.Data(map[string]float64{"retry_after": limited.RetryAfter.Seconds()})}
	}
	return err
}
