package feishu

import (
	"context"
	"io"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	"github.com/relanox/relanox/internal/channels/common"
)

// Disable SDK token refresh/replay: resolved credentials and retry decisions
// remain owned by the operation and durable Core queue, respectively.
func (c *Channel) sdkConfig(ctx context.Context, maximum int64) *larkcore.Config {
	return &larkcore.Config{
		BaseUrl: c.base(), AppId: c.config.AppID, AppType: larkcore.AppTypeSelfBuilt,
		HttpClient:   common.SDKHTTPClient(c.options.HTTPClient, ctx, maximum),
		Serializable: &larkcore.DefaultSerialization{}, Logger: quietLogger{},
		EnableTokenCache: false,
	}
}

func (c *Channel) imClient(ctx context.Context, maximum int64) *larkim.V1 {
	return larkim.New(c.sdkConfig(ctx, maximum))
}

func nativeError(response *larkcore.ApiResp, err error) error {
	if response != nil && (response.StatusCode < 200 || response.StatusCode >= 300) {
		return &common.HTTPError{Status: response.StatusCode, Header: response.Header, Body: response.RawBody}
	}
	return err
}

type quietLogger struct{}

func (quietLogger) Debug(context.Context, ...interface{}) {}
func (quietLogger) Info(context.Context, ...interface{})  {}
func (quietLogger) Warn(context.Context, ...interface{})  {}
func (quietLogger) Error(context.Context, ...interface{}) {}

// The SDK recognizes Name on an uploaded reader and preserves the native file
// part's filename without writing owned media to a temporary filesystem path.
type namedReader struct {
	io.Reader
	name string
}

func (r namedReader) Name() string { return r.name }

func nativeString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nativeUserID(value *larkim.UserId) string {
	if value == nil {
		return ""
	}
	return nativeString(value.OpenId)
}

func projectMessage(message *larkim.EventMessage) nativeMessage {
	return nativeMessage{
		ID: nativeString(message.MessageId), ChatID: nativeString(message.ChatId),
		Type: nativeString(message.MessageType), Content: nativeString(message.Content),
		RootID: nativeString(message.RootId), ThreadID: nativeString(message.ThreadId),
		Mentions: message.Mentions,
	}
}
