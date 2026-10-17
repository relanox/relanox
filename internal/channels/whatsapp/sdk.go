package whatsapp

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"

	waconfig "github.com/piusalfred/whatsapp/config"
	wamessage "github.com/piusalfred/whatsapp/message"
	whttp "github.com/piusalfred/whatsapp/pkg/http"
	"github.com/relanox/relanox/internal/channels/common"
)

func (c *Channel) sendMessage(ctx context.Context, body *wamessage.Message, headers http.Header) (*wamessage.Response, error) {
	client := common.SDKHTTPClient(c.client, ctx, common.MaxJSONBytes)
	sender := &wamessage.BaseSender{Sender: whttp.NewSender[wamessage.Message](whttp.WithCoreClientHTTPClient[wamessage.Message](client), whttp.WithCoreClientResponseInterceptor[wamessage.Message](sdkStatus))}
	conf := &waconfig.Config{BaseURL: apiBase, APIVersion: apiVersion, PhoneNumberID: url.PathEscape(c.config.PhoneNumberID), AccessToken: strings.TrimPrefix(headers.Get("Authorization"), "Bearer "), DebugLogLevel: "none"}
	// The platform may add response fields. The high-level BaseClient forces
	// DisallowUnknownFields, so use its public request sender with native decoding.
	request := wamessage.NewBaseRequest(body, wamessage.WithBaseRequestDecodeOptions(whttp.DecodeOptions{DisallowEmptyResponse: true, InspectResponseError: true}))
	return sender.SendRequest(ctx, conf, request)
}

func sdkStatus(_ context.Context, response *http.Response) error {
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	// SDK ResponseError.Code is a business code, not the HTTP status. Preserve
	// the bounded body and headers for Cloud API rate limits and Retry-After.
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	return &common.HTTPError{Status: response.StatusCode, Header: response.Header, Body: body}
}

func setMedia(body *wamessage.Message, value *wamessage.Media) {
	switch body.Type {
	case "image":
		body.Image = &wamessage.Image{ID: value.ID, Caption: value.Caption}
	case "audio":
		body.Audio = &wamessage.Audio{ID: value.ID}
	case "video":
		body.Video = &wamessage.Video{ID: value.ID, Caption: value.Caption}
	case "document":
		body.Document = &wamessage.Document{ID: value.ID, Caption: value.Caption, Filename: value.Filename}
	}
}
