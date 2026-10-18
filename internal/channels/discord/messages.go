package discord

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

func (c *Channel) dispatchMessage(ctx context.Context, raw json.RawMessage, bot *identity, state *gatewayState) error {
	var message discordgo.Message
	if json.Unmarshal(raw, &message) != nil || !snowflake(message.ID) {
		return errors.New("invalid_native_message")
	}
	// A surviving old session may replay posts from before a newly configured
	// binding existed. Its persisted scope boundary applies to resume replay as
	// well as REST compensation; previously unauthorized history stays skipped.
	if started := state.BoundSinceMS[message.ChannelID]; started > state.StartedAtMS && started >= discordEpochMS {
		if messageNumber(message.ID) < uint64(started-discordEpochMS)<<22 {
			return nil
		}
	}
	if err := c.receiveMessage(ctx, message, bot, nil); err != nil && !common.PolicyRejection(err) {
		return err
	}
	return c.rememberMessage(message.ID, message.ChannelID, state)
}

func (c *Channel) receiveMessage(ctx context.Context, message discordgo.Message, bot *identity, known *discordgo.Channel) error {
	if !snowflake(message.ID) || !snowflake(message.ChannelID) || message.Author == nil {
		return errors.New("invalid_native_message")
	}
	if message.Author.Bot || message.Author.ID == bot.UserID || !slices.Contains(c.account.AllowedSenders, message.Author.ID) {
		return nil
	}
	if message.Type != discordgo.MessageTypeDefault && message.Type != discordgo.MessageTypeReply {
		return nil
	}
	if _, bound := c.boundAddress(message.ChannelID); !bound {
		return nil
	}
	native, err := c.messageChannel(ctx, message, known)
	if err != nil {
		return err
	}
	chat, thread := native.ID, ""
	if native.IsThread() {
		chat, thread = native.ParentID, native.ID
	}
	if !slices.Contains(c.host.BoundChatIDs(), chat) {
		return nil
	}
	attachments, err := c.attachments(ctx, message.Attachments)
	if err != nil {
		return err
	}
	if message.Content == "" && len(attachments) == 0 {
		return nil
	}
	received := message.Timestamp
	if received.IsZero() {
		return errors.New("invalid_native_timestamp")
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.Discord, AccountID: c.account.ID, EventID: message.ID}, SenderID: message.Author.ID, Text: message.Content, Attachments: attachments, ReceivedAt: received, Target: model.ReplyTarget{Channel: model.Discord, AccountID: c.account.ID, ChatID: chat, ThreadID: thread, ReplyToID: message.ID, Data: common.Data(targetData{APIBaseURL: c.config.APIBaseURL, BotID: bot.UserID, GuildID: native.GuildID})}})
}

func (c *Channel) messageChannel(ctx context.Context, message discordgo.Message, known *discordgo.Channel) (*discordgo.Channel, error) {
	native := known
	if native == nil {
		var channel discordgo.Channel
		if err := c.api(ctx, http.MethodGet, "/channels/"+message.ChannelID, nil, &channel); err != nil {
			return nil, err
		}
		native = &channel
	}
	if native.ID != message.ChannelID || message.GuildID != "" && native.GuildID != message.GuildID {
		return nil, errors.New("native_channel_identity_changed")
	}
	return native, nil
}

func (c *Channel) attachments(ctx context.Context, native []*discordgo.MessageAttachment) ([]model.MediaUpload, error) {
	if len(native) > 10 {
		return nil, errors.New("too_many_attachments")
	}
	result := make([]model.MediaUpload, 0, len(native))
	for _, file := range native {
		if file == nil || file.Size < 0 || int64(file.Size) > common.MediaLimit(c.host) {
			return nil, errors.New("media_too_large")
		}
		u, err := url.Parse(file.URL)
		if err != nil || u.Scheme != "https" || (u.Hostname() != "cdn.discordapp.com" && u.Hostname() != "media.discordapp.net" && common.Origin(file.URL) != common.Origin(c.config.APIBaseURL)) {
			return nil, errors.New("invalid_attachment_url")
		}
		data, err := common.Download(ctx, file.URL, common.DownloadOptions{MaxBytes: common.MediaLimit(c.host), TrustedOrigins: []string{common.Origin(c.config.APIBaseURL)}, TLSClientConfig: c.options.TLSClientConfig})
		if err != nil {
			return nil, err
		}
		mimeType := file.ContentType
		if mimeType == "" {
			mimeType = data.MIMEType
		}
		media := model.MediaUpload{Kind: common.MediaKind(mimeType), MIMEType: mimeType, FileName: file.Filename, Data: data.Data}
		if file.DurationSecs > 0 {
			duration := int64(file.DurationSecs * 1000)
			media.DurationMS = &duration
		}
		result = append(result, media)
	}
	return result, nil
}

// Discord's create-message nonce is bounded to 25 characters and server dedupe
// lasts only a few minutes. It reduces immediate duplicates but is insufficient
// to advertise durable idempotence to Core across arbitrary restart delays.
type nativeSend struct {
	discordgo.MessageSend
	Nonce        string `json:"nonce"`
	EnforceNonce bool   `json:"enforce_nonce"`
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	if !snowflake(input.Target.ChatID) || input.Target.ThreadID != "" && !snowflake(input.Target.ThreadID) {
		return common.Reject("invalid_target"), nil
	}
	bot, err := c.identify(ctx)
	if err != nil {
		return common.Failure(err, true), nil
	}
	native, err := c.nativeChannel(ctx, input.Target.ChatID, input.Target.ThreadID)
	if err != nil {
		return common.Failure(err, true), nil
	}
	if !c.validTarget(input.Target, bot, native) {
		return common.Reject("target_identity_changed"), nil
	}
	limits := richLimits
	limits.MaxImageBytes = min(common.MediaLimit(c.host), 10<<20)
	if code := common.ValidateRichWithLabelLimit(input, limits, model.UTF16, common.MediaLimit(c.host), 0); code != "" {
		return common.Reject(code), nil
	}
	if text.Length(input.Chunk.Text, model.UTF16) > 2000 {
		return common.Reject("text_limit_exceeded"), nil
	}
	if input.Chunk.IdempotencyKey == "" {
		return common.Reject("missing_idempotency_key"), nil
	}
	payload, files, err := c.message(input)
	if err != nil {
		return common.Reject("invalid_media"), nil
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	var response discordgo.Message
	endpoint := c.config.APIBaseURL + "/channels/" + native.ID + "/messages"
	if len(files) > 0 {
		err = c.multipart(ctx, endpoint, payload, files, &response)
	} else {
		err = c.api(ctx, http.MethodPost, "/channels/"+native.ID+"/messages", payload, &response)
	}
	if err != nil {
		return failure(err, false), nil
	}
	if !snowflake(response.ID) || response.ChannelID != native.ID {
		return model.SendResult{Status: model.Unknown, ErrorCode: "native_invalid_response"}, nil
	}
	return common.Sent(response.ID), nil
}

func failure(err error, preparing bool) model.SendResult {
	var native *common.HTTPError
	if errors.As(err, &native) && native.Status == 429 {
		var body struct {
			RetryAfter float64 `json:"retry_after"`
		}
		_ = json.Unmarshal(native.Body, &body)
		return common.Retry("rate_limited", time.Duration(body.RetryAfter*float64(time.Second)))
	}
	return common.Failure(err, preparing)
}

func (c *Channel) multipart(ctx context.Context, endpoint string, payload nativeSend, files []*discordgo.File, output any) error {
	contentType, body, err := discordgo.MultipartBodyWithJSON(payload, files)
	if err != nil {
		return err
	}
	return c.nativeRequest(ctx, http.MethodPost, endpoint, contentType, body, output)
}

func (c *Channel) message(input model.SendInput) (nativeSend, []*discordgo.File, error) {
	hash := sha256.Sum256([]byte(input.Chunk.IdempotencyKey))
	message := nativeSend{MessageSend: discordgo.MessageSend{Content: input.Chunk.Text, AllowedMentions: &discordgo.MessageAllowedMentions{Parse: []discordgo.AllowedMentionType{}, RepliedUser: false}}, Nonce: hex.EncodeToString(hash[:])[:25], EnforceNonce: true}
	if input.Reply != nil && input.Target.ReplyToID != "" {
		if !snowflake(input.Target.ReplyToID) {
			return message, nil, errors.New("invalid_quote")
		}
		fail := false
		message.Reference = &discordgo.MessageReference{MessageID: input.Target.ReplyToID, FailIfNotExists: &fail}
	}
	if len(input.Chunk.RichText) > 0 {
		return c.richMessage(message, input)
	}
	if input.Chunk.Media == nil {
		return message, nil, nil
	}
	if input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID {
		return message, nil, errors.New("invalid_media")
	}
	file, err := c.file(*input.Media, input.Media.Reference.FileName)
	if err != nil {
		return message, nil, err
	}
	files := []*discordgo.File{file}
	if input.Preview != nil {
		preview, err := c.file(*input.Preview, "preview.png")
		if err != nil {
			return message, nil, err
		}
		files = append(files, preview)
		message.Embeds = []*discordgo.MessageEmbed{{Thumbnail: &discordgo.MessageEmbedThumbnail{URL: "attachment://preview.png"}}}
	}
	return message, files, nil
}

func (c *Channel) file(media model.StoredMedia, name string) (*discordgo.File, error) {
	if len(media.Data) == 0 || int64(len(media.Data)) != media.Reference.Size || int64(len(media.Data)) > min(common.MediaLimit(c.host), 20<<20) || name == "" || strings.ContainsAny(name, "\r\n\x00") || strings.ContainsAny(media.Reference.MIMEType, "\r\n") {
		return nil, errors.New("invalid_media")
	}
	return &discordgo.File{Name: name, ContentType: media.Reference.MIMEType, Reader: bytes.NewReader(media.Data)}, nil
}

func (c *Channel) richMessage(message nativeSend, input model.SendInput) (nativeSend, []*discordgo.File, error) {
	message.Content = ""
	message.Flags = discordgo.MessageFlagsIsComponentsV2
	var files []*discordgo.File
	for _, part := range input.Chunk.RichText {
		if part.Type == "text" {
			message.Components = append(message.Components, discordgo.TextDisplay{Content: part.Text})
			continue
		}
		if part.Media == nil || len(files) >= len(input.RichMedia) {
			return message, nil, errors.New("invalid_media")
		}
		name := richFileName(input.RichMedia[len(files)].Reference.FileName, len(files))
		file, err := c.file(input.RichMedia[len(files)], name)
		if err != nil {
			return message, nil, err
		}
		files = append(files, file)
		label := text.Truncate(part.Label, 1024, model.UTF16)
		message.Components = append(message.Components, discordgo.MediaGallery{Items: []discordgo.MediaGalleryItem{{Media: discordgo.UnfurledMediaItem{URL: "attachment://" + name}, Description: &label}}})
	}
	return message, files, nil
}

func richFileName(value string, index int) string {
	segments := strings.Split(value, ".")
	extension := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, strings.ToLower(segments[len(segments)-1]))
	if extension == "" {
		extension = "bin"
	}
	extension = extension[:min(10, len(extension))]
	return "image-" + strconv.Itoa(index) + "." + extension
}
