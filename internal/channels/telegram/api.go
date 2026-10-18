package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

type apiError struct {
	code  int
	retry time.Duration
}

func (e *apiError) Error() string { return "telegram_api_rejected" }

func (c *Channel) sdk(ctx context.Context) (*bot.Bot, error) {
	token, err := c.options.Secret(c.config.BotToken)
	if err != nil {
		return nil, err
	}
	if _, err = c.identity(); err != nil {
		return nil, err
	}
	if strings.ContainsAny(token, "/?#\r\n") {
		return nil, errors.New("invalid_bot_token")
	}
	// Only outbound operations use the SDK: webhook acceptance must finish its
	// durable Core ingest before sending the platform's acknowledgement.
	client := telegramHTTP{client: common.SDKHTTPClient(c.client, ctx, common.MaxJSONBytes)}
	return bot.New(token, bot.WithSkipGetMe(), bot.WithUpdatesChannelCap(1), bot.WithServerURL(c.config.APIBaseURL), bot.WithHTTPClient(0, client))
}

type telegramHTTP struct{ client *http.Client }

func (c telegramHTTP) Do(request *http.Request) (*http.Response, error) {
	response, err := c.client.Do(request)
	if err != nil || response.StatusCode >= 200 && response.StatusCode < 300 {
		return response, err
	}
	defer func() { _ = response.Body.Close() }()
	// The SDK accepts an ok:true body even on HTTP 500. Keep HTTP failures
	// observable while preserving the native envelope for retry_after below.
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	return nil, &common.HTTPError{Status: response.StatusCode, Header: response.Header, Body: body}
}

func sdkError(err error) error {
	var native *common.HTTPError
	if errors.As(err, &native) {
		var body struct {
			OK         bool `json:"ok"`
			Code       int  `json:"error_code"`
			Parameters struct {
				RetryAfter float64 `json:"retry_after"`
			} `json:"parameters"`
		}
		if json.Unmarshal(native.Body, &body) == nil && !body.OK && body.Code != 0 {
			return &apiError{code: body.Code, retry: time.Duration(body.Parameters.RetryAfter * float64(time.Second))}
		}
	}
	var limited *bot.TooManyRequestsError
	if errors.As(err, &limited) {
		return &apiError{code: 429, retry: time.Duration(limited.RetryAfter) * time.Second}
	}
	for _, entry := range []struct {
		err  error
		code int
	}{{bot.ErrorBadRequest, 400}, {bot.ErrorUnauthorized, 401}, {bot.ErrorForbidden, 403}, {bot.ErrorNotFound, 404}, {bot.ErrorConflict, 409}} {
		if errors.Is(err, entry.err) {
			return &apiError{code: entry.code}
		}
	}
	var migrate *bot.MigrateError
	if errors.As(err, &migrate) {
		return &apiError{code: 400}
	}
	return err
}

var safeFile = regexp.MustCompile(`^[A-Za-z0-9_./-]+$`)

func validFilePath(value string) bool {
	if !safeFile.MatchString(value) || strings.HasPrefix(value, "/") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func selected(m message) (*file, model.MediaKind, string) {
	if len(m.Photos) > 0 {
		return &m.Photos[len(m.Photos)-1], model.Image, "image/jpeg"
	}
	for _, v := range []struct {
		f    *file
		k    model.MediaKind
		mime string
	}{{m.Audio, model.Audio, "audio/mpeg"}, {m.Voice, model.Audio, "audio/ogg"}, {m.Video, model.Video, "video/mp4"}, {m.Animation, model.Video, "video/mp4"}, {m.VideoNote, model.Video, "video/mp4"}, {m.Document, model.File, "application/octet-stream"}} {
		if v.f != nil {
			if v.f == m.Animation && v.f.MIME != "" {
				return v.f, common.MediaKind(v.f.MIME), v.f.MIME
			}
			return v.f, v.k, v.mime
		}
	}
	return nil, "", ""
}

func (c *Channel) download(ctx context.Context, m message) ([]model.MediaUpload, error) {
	f, kind, mimeType := selected(m)
	if f == nil {
		return nil, nil
	}
	maximum := min(common.MediaLimit(c.host), 20*1024*1024)
	if f.ID == "" || f.Size < 0 || f.Size > maximum {
		return nil, errors.New("media_too_large")
	}
	client, err := c.sdk(ctx)
	if err != nil {
		return nil, err
	}
	result, err := client.GetFile(ctx, &bot.GetFileParams{FileID: f.ID})
	if err != nil {
		return nil, sdkError(err)
	}
	if result == nil || !validFilePath(result.FilePath) || result.FileSize < 0 || result.FileSize > maximum {
		return nil, errors.New("invalid_telegram_file")
	}
	token, err := c.options.Secret(c.config.BotToken)
	if err != nil {
		return nil, err
	}
	data, err := common.Download(ctx, c.config.APIBaseURL+"/file/bot"+token+"/"+result.FilePath, common.DownloadOptions{MaxBytes: maximum, TrustedOrigins: []string{common.Origin(c.config.APIBaseURL)}, AllowInsecureLoopback: c.config.AllowInsecureLoopback, TLSClientConfig: c.options.TLSClientConfig})
	if err != nil {
		return nil, err
	}
	if f.MIME != "" {
		mimeType = f.MIME
	}
	name := f.Name
	if name == "" {
		name = path.Base(result.FilePath)
	}
	upload := model.MediaUpload{Kind: kind, MIMEType: mimeType, FileName: name, Data: data.Data}
	if f.Duration > 0 && f.Duration <= float64(math.MaxInt64/1000) {
		duration := int64(f.Duration * 1000)
		upload.DurationMS = &duration
	}
	return []model.MediaUpload{upload}, nil
}

func failure(err error, preparing bool) model.SendResult {
	var native *apiError
	if errors.As(err, &native) {
		if native.code == 429 {
			return common.Retry("rate_limited", native.retry)
		}
		if native.code >= 400 && native.code < 500 && native.code != 408 {
			return common.Reject("platform_request_rejected")
		}
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}
	}
	var httpError *common.HTTPError
	if errors.As(err, &httpError) && httpError.Status == 408 {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}
	}
	return common.Failure(err, preparing)
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	identity, err := c.identity()
	if err != nil {
		return failure(err, true), nil
	}
	if !c.validTarget(input.Target, identity) {
		return common.Reject("invalid_target"), nil
	}
	if input.Target.ThreadID != "" && !positiveID.MatchString(input.Target.ThreadID) {
		return common.Reject("invalid_thread"), nil
	}
	if len(input.Chunk.RichText) > 0 {
		return common.Reject("rich_text_unsupported"), nil
	}
	if input.Chunk.Media != nil && (input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID || int64(len(input.Media.Data)) != input.Media.Reference.Size) {
		return common.Reject("invalid_media"), nil
	}
	if err = ctx.Err(); err != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	limit := 4096
	if input.Chunk.Media != nil {
		limit = 1024
	}
	rendered := text.Telegram(input.Chunk.Text)
	if text.Length(rendered.Text, model.Codepoint) > limit {
		return common.Reject("text_limit_exceeded"), nil
	}
	client, err := c.sdk(ctx)
	if err != nil {
		return failure(err, true), nil
	}
	thread, reply, err := sdkTarget(input)
	if err != nil {
		return common.Reject(err.Error()), nil
	}
	var sent *models.Message
	if input.Chunk.Media == nil {
		sent, err = client.SendMessage(ctx, &bot.SendMessageParams{ChatID: input.Target.ChatID, MessageThreadID: thread, ReplyParameters: reply, Text: rendered.Text, Entities: sdkEntities(rendered.Entities), LinkPreviewOptions: &models.LinkPreviewOptions{IsDisabled: bot.True()}})
	} else {
		sent, err = c.sendMedia(ctx, client, input, thread, reply, rendered)
	}
	if err != nil {
		return failure(sdkError(err), false), nil
	}
	if sent == nil || sent.ID <= 0 {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_invalid_response"}, nil
	}
	return common.Sent(strconv.Itoa(sent.ID)), nil
}

func (c *Channel) validTarget(input model.ReplyTarget, identity targetData) bool {
	var target targetData
	return input.Channel == model.Telegram && input.AccountID == c.account.ID && integerID.MatchString(input.ChatID) && json.Unmarshal(input.Data, &target) == nil && target == identity
}

func mediaMethod(ref model.MediaReference) (string, string, int64) {
	switch ref.Kind {
	case model.Image:
		if ref.MIMEType == "image/gif" {
			return "sendAnimation", "animation", 50 * 1024 * 1024
		}
		return "sendPhoto", "photo", 10 * 1024 * 1024
	case model.Audio:
		if slices.Contains([]string{"audio/ogg", "audio/opus"}, ref.MIMEType) {
			return "sendVoice", "voice", 50 * 1024 * 1024
		}
		if slices.Contains([]string{"audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/mp4", "audio/m4a", "audio/x-m4a"}, ref.MIMEType) {
			return "sendAudio", "audio", 50 * 1024 * 1024
		}
	case model.Video:
		return "sendVideo", "video", 50 * 1024 * 1024
	}
	return "sendDocument", "document", 50 * 1024 * 1024
}

func sdkTarget(input model.SendInput) (int, *models.ReplyParameters, error) {
	thread := 0
	if input.Target.ThreadID != "" {
		value, err := strconv.Atoi(input.Target.ThreadID)
		if err != nil {
			return 0, nil, errors.New("invalid_thread")
		}
		thread = value
	}
	if input.Reply == nil || !positiveID.MatchString(input.Target.ReplyToID) {
		return thread, nil, nil
	}
	id, err := strconv.Atoi(input.Target.ReplyToID)
	if err != nil {
		return 0, nil, errors.New("invalid_reply")
	}
	return thread, &models.ReplyParameters{MessageID: id, AllowSendingWithoutReply: true}, nil
}

func sdkEntities(entities []text.TelegramEntity) []models.MessageEntity {
	result := make([]models.MessageEntity, 0, len(entities))
	for _, entity := range entities {
		result = append(result, models.MessageEntity{Type: models.MessageEntityType(entity.Type), Offset: entity.Offset, Length: entity.Length, URL: entity.URL, Language: entity.Language})
	}
	return result
}
