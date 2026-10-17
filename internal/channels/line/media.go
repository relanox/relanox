package line

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	sdk "github.com/line/line-bot-sdk-go/v8/linebot/messaging_api"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

func (c *Channel) nativeContent(ctx context.Context, id string) (common.Downloaded, error) {
	headers, err := c.headers()
	if err != nil {
		return common.Downloaded{}, err
	}
	client, err := sdk.NewMessagingApiBlobAPI(strings.TrimPrefix(headers.Get("Authorization"), "Bearer "), sdk.WithBlobHTTPClient(common.SDKHTTPClient(c.client, ctx, common.MediaLimit(c.host))))
	if err != nil {
		return common.Downloaded{}, err
	}
	client.WithContext(ctx)
	for attempt := 0; attempt < 3; attempt++ {
		response, _, err := client.GetMessageContentWithHttpInfo(id)
		if err := nativeError(response, err); err != nil {
			return common.Downloaded{}, err
		}
		if response.StatusCode == 202 {
			response.Body.Close()
			if err = common.Delay(ctx, 500*time.Millisecond); err != nil {
				return common.Downloaded{}, err
			}
			continue
		}
		result, err := c.readContent(response)
		response.Body.Close()
		return result, err
	}
	return common.Downloaded{}, errors.New("media_content_preparing")
}

func (c *Channel) readContent(response *http.Response) (common.Downloaded, error) {
	if response.StatusCode != 200 {
		return common.Downloaded{}, &common.HTTPError{Status: response.StatusCode, Header: response.Header}
	}
	maximum := common.MediaLimit(c.host)
	if response.ContentLength > maximum {
		return common.Downloaded{}, errors.New("media_too_large")
	}
	raw, err := common.ReadBounded(response.Body, maximum)
	return common.Downloaded{Data: raw, MIMEType: strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))}, err
}

func (c *Channel) receiveMedia(ctx context.Context, m nativeMessage) ([]model.MediaUpload, error) {
	if m.Type == "text" {
		return nil, nil
	}
	if m.Size < 0 || m.Size > common.MediaLimit(c.host) {
		return nil, errors.New("media_too_large")
	}
	var downloaded common.Downloaded
	var err error
	if m.Provider != nil && m.Provider.Type == "external" {
		downloaded, err = common.Download(ctx, m.Provider.OriginalContentUrl, common.DownloadOptions{MaxBytes: common.MediaLimit(c.host), TLSClientConfig: c.options.TLSClientConfig})
	} else {
		downloaded, err = c.nativeContent(ctx, m.ID)
	}
	if err != nil {
		return nil, err
	}
	fallback := map[string]string{"image": "image/jpeg", "audio": "audio/mp4", "video": "video/mp4", "file": "application/octet-stream"}
	mimeType := downloaded.MIMEType
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = fallback[m.Type]
	}
	name := m.Filename
	if name == "" {
		name = m.ID + ".bin"
	}
	upload := model.MediaUpload{Kind: model.MediaKind(m.Type), MIMEType: mimeType, FileName: name, Data: downloaded.Data}
	if m.Duration > 0 && (m.Type == "audio" || m.Type == "video") {
		upload.DurationMS = &m.Duration
	}
	return []model.MediaUpload{upload}, nil
}

type retryIdentity struct {
	Key       string `json:"retryKey"`
	StartedAt int64  `json:"startedAt"`
}

func (c *Channel) retry(ctx context.Context, key string) (retryIdentity, error) {
	if key == "" {
		return retryIdentity{}, errors.New("missing_idempotency_key")
	}
	stateKey := "push:" + key
	value, entry, err := common.ReadState[retryIdentity](ctx, c.host.State(), stateKey)
	if err != nil {
		return value, err
	}
	if entry != nil {
		return value, validRetry(value)
	}
	value = retryIdentity{Key: uuid.NewString(), StartedAt: time.Now().UnixMilli()}
	result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: stateKey, Value: common.Data(value)})
	if err != nil {
		return value, err
	}
	if result.Status == model.Updated {
		return value, nil
	}
	value, entry, err = common.ReadState[retryIdentity](ctx, c.host.State(), stateKey)
	if err != nil {
		return value, err
	}
	if entry == nil {
		return value, errors.New("retry_identity_conflict")
	}
	return value, validRetry(value)
}

func validRetry(value retryIdentity) error {
	if _, err := uuid.Parse(value.Key); err != nil || value.StartedAt < 0 {
		return errors.New("invalid_retry_identity")
	}
	return nil
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	headers, err := c.headers()
	if err != nil {
		return common.Failure(err, true), nil
	}
	botID, err := c.identityFor(ctx, headers)
	if err != nil {
		return common.Failure(err, true), nil
	}
	target, ok := c.validTarget(input.Target, botID)
	if !ok {
		return common.Reject("invalid_target"), nil
	}
	if code := common.ValidateRich(input, richLimits, model.UTF16, common.MediaLimit(c.host)); code != "" {
		return common.Reject(code), nil
	}
	messages, err := c.messages(ctx, input, target)
	if err != nil {
		if common.Contains([]string{"native_file_send_unsupported", "audio_requires_duration", "media_requires_preview", "invalid_media", "media_format_unsupported", "media_too_large", "rich_text_limit_exceeded", "text_limit_exceeded"}, err.Error()) {
			return common.Reject(err.Error()), nil
		}
		return common.Failure(err, true), nil
	}
	retry, err := c.retry(ctx, input.Chunk.IdempotencyKey)
	if err != nil {
		return model.SendResult{}, err
	}
	if time.Now().UnixMilli()-retry.StartedAt >= int64(24*time.Hour/time.Millisecond) {
		return model.SendResult{Status: model.Unknown, ErrorCode: "retry_key_expired"}, nil
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	client, err := c.nativeClient(ctx, headers)
	if err != nil {
		return common.Failure(err, true), nil
	}
	response, result, err := client.PushMessageWithHttpInfo(&sdk.PushMessageRequest{To: target.Destination, Messages: messages}, retry.Key)
	if err := nativeError(response, err); err != nil {
		return lineFailure(err), nil
	}
	receipt := common.Sent("")
	if result != nil && len(result.SentMessages) > 0 {
		receipt.Receipt.PlatformMessageID = result.SentMessages[0].Id
	}
	return receipt, nil
}

func lineFailure(err error) model.SendResult {
	var native *common.HTTPError
	if errors.As(err, &native) {
		if native.Status == 409 && native.Header.Get("X-Line-Accepted-Request-Id") != "" {
			return model.SendResult{Status: model.Sent, Receipt: &model.SendReceipt{Data: common.Data(map[string]string{"acceptedRequestId": native.Header.Get("X-Line-Accepted-Request-Id")})}}
		}
		if native.Status >= 500 || native.Status == 408 {
			return common.Retry("native_retry_key_retained", time.Second)
		}
	}
	result := common.Failure(err, false)
	if result.Status == model.Unknown {
		return common.Retry("native_retry_key_retained", time.Second)
	}
	return result
}

func (c *Channel) publish(ctx context.Context, input model.SendInput, id string) (string, error) {
	if c.host.Media() == nil {
		return "", errors.New("public_media_unavailable")
	}
	value, err := c.host.Media().Publish(ctx, input.ChannelID, id, time.Hour)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || text.Length(value, model.UTF16) > 2000 {
		return "", errors.New("invalid_publication_url")
	}
	return value, nil
}

func (c *Channel) messages(ctx context.Context, input model.SendInput, target targetData) ([]sdk.MessageInterface, error) {
	if len(input.Chunk.RichText) > 0 {
		message, err := c.rich(ctx, input)
		return []sdk.MessageInterface{message}, err
	}
	var messages []sdk.MessageInterface
	if input.Chunk.Text != "" {
		var message sdk.MessageInterface = flex(input.Chunk.Text)
		if input.Reply != nil && target.QuoteToken != "" {
			message = &sdk.TextMessage{Text: quotedPlain(input.Chunk.Text), QuoteToken: target.QuoteToken}
		}
		if text.Length(quotedPlain(input.Chunk.Text), model.UTF16) > 5000 || len(common.Data(message)) > 30000 {
			return nil, errors.New("text_limit_exceeded")
		}
		messages = append(messages, message)
	}
	if input.Chunk.Media != nil {
		media, err := c.outboundMedia(ctx, input)
		if err != nil {
			return nil, err
		}
		messages = append(messages, media)
	}
	if len(messages) == 0 {
		return nil, errors.New("text_limit_exceeded")
	}
	return messages, nil
}

func (c *Channel) outboundMedia(ctx context.Context, input model.SendInput) (sdk.MessageInterface, error) {
	if input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID || input.Media.Reference.Size != int64(len(input.Media.Data)) || int64(len(input.Media.Data)) > common.MediaLimit(c.host) {
		return nil, errors.New("invalid_media")
	}
	ref := input.Media.Reference
	if code := validateMedia(ref, input.Preview); code != "" {
		return nil, errors.New(code)
	}
	if ref.Kind == model.File {
		return nil, errors.New("native_file_send_unsupported")
	}
	if ref.Kind == model.Audio && (ref.DurationMS == nil || *ref.DurationMS <= 0) {
		return nil, errors.New("audio_requires_duration")
	}
	if ref.Kind == model.Video && input.Preview == nil {
		return nil, errors.New("media_requires_preview")
	}
	original, err := c.publish(ctx, input, ref.ID)
	if err != nil {
		return nil, err
	}
	if ref.Kind == model.Audio {
		return &sdk.AudioMessage{OriginalContentUrl: original, Duration: *ref.DurationMS}, nil
	}
	preview := original
	if input.Preview != nil {
		preview, err = c.publish(ctx, input, input.Preview.Reference.ID)
		if err != nil {
			return nil, err
		}
	}
	if ref.Kind == model.Video {
		return &sdk.VideoMessage{OriginalContentUrl: original, PreviewImageUrl: preview}, nil
	}
	return &sdk.ImageMessage{OriginalContentUrl: original, PreviewImageUrl: preview}, nil
}

// Limits and formats are native Messaging API contracts, including the tighter
// one-megabyte preview bound even when the original image can be ten megabytes.
// https://developers.line.biz/en/reference/messaging-api/index.html.md
func validateMedia(ref model.MediaReference, preview *model.StoredMedia) string {
	switch ref.Kind {
	case model.File:
		return "native_file_send_unsupported"
	case model.Image:
		if !common.Contains([]string{"image/png", "image/jpeg"}, ref.MIMEType) {
			return "media_format_unsupported"
		}
		if ref.Size > 10_000_000 {
			return "media_too_large"
		}
		if ref.Size > 1_000_000 && preview == nil {
			return "media_requires_preview"
		}
	case model.Audio:
		if !common.Contains([]string{"audio/mpeg", "audio/mp4", "audio/x-m4a"}, ref.MIMEType) {
			return "media_format_unsupported"
		}
		if ref.Size > 200_000_000 {
			return "media_too_large"
		}
	case model.Video:
		if ref.MIMEType != "video/mp4" {
			return "media_format_unsupported"
		}
		if ref.Size > 200_000_000 {
			return "media_too_large"
		}
	default:
		return "media_format_unsupported"
	}
	if preview != nil && (preview.Reference.Kind != model.Image || !common.Contains([]string{"image/jpeg", "image/png"}, preview.Reference.MIMEType) || int64(len(preview.Data)) != preview.Reference.Size || preview.Reference.Size > 1_000_000 || preview.Reference.Size <= 0) {
		return "invalid_media"
	}
	return ""
}

func quotedPlain(value string) string {
	var out strings.Builder
	for _, run := range text.Runs(value) {
		out.WriteString(run.Text)
		if run.Href != "" && run.Href != run.Text {
			out.WriteString(" (" + run.Href + ")")
		}
	}
	return out.String()
}

func spans(value string) []sdk.FlexComponentInterface {
	var out []sdk.FlexComponentInterface
	var paragraph []sdk.FlexSpan
	flush := func() {
		if len(paragraph) > 0 {
			out = append(out, &sdk.FlexText{Wrap: true, Contents: paragraph})
			paragraph = nil
		}
	}
	for _, run := range text.Runs(value) {
		span := sdk.FlexSpan{Text: run.Text}
		if run.Bold {
			span.Weight = "bold"
		}
		if run.Italic {
			span.Style = "italic"
		}
		if run.Strike {
			span.Decoration = "line-through"
		}
		if run.Href != "" {
			flush()
			item := &sdk.FlexText{Wrap: true, Contents: []sdk.FlexSpan{span}, Action: &sdk.UriAction{Uri: run.Href}}
			out = append(out, item)
		} else {
			paragraph = append(paragraph, span)
		}
	}
	flush()
	return out
}

func flex(value string) *sdk.FlexMessage { return flexContents(text.Plain(value), spans(value)) }

func flexContents(label string, contents []sdk.FlexComponentInterface) *sdk.FlexMessage {
	runes := []rune(label)
	if len(runes) > 500 {
		label = string(runes[:500])
	}
	if label == "" {
		label = "Message"
	}
	return &sdk.FlexMessage{AltText: label, Contents: &sdk.FlexBubble{Body: &sdk.FlexBox{Layout: "vertical", Contents: contents}}}
}

func (c *Channel) rich(ctx context.Context, input model.SendInput) (*sdk.FlexMessage, error) {
	var contents []sdk.FlexComponentInterface
	var labels []string
	for _, part := range input.Chunk.RichText {
		if part.Type == "text" {
			contents = append(contents, spans(part.Text)...)
			labels = append(labels, text.Plain(part.Text))
			continue
		}
		if part.Media == nil {
			return nil, errors.New("invalid_media")
		}
		image, err := c.publish(ctx, input, part.Media.ID)
		if err != nil {
			return nil, err
		}
		contents = append(contents, &sdk.FlexImage{Url: image, Size: "full", AspectMode: "fit"})
		labels = append(labels, part.Label)
	}
	message := flexContents(strings.Join(labels, "\n"), contents)
	if len(common.Data(message)) > 30000 {
		return nil, errors.New("rich_text_limit_exceeded")
	}
	return message, nil
}
