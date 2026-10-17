package wecom

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type resource struct {
	URL      string `json:"url"`
	AESKey   string `json:"aeskey"`
	FileName string `json:"filename"`
}

type nativeText struct {
	Content string `json:"content"`
}

type messagePart struct {
	Type  string      `json:"msgtype"`
	Text  *nativeText `json:"text,omitempty"`
	Image *resource   `json:"image,omitempty"`
	Video *resource   `json:"video,omitempty"`
	File  *resource   `json:"file,omitempty"`
}

type nativeMessage struct {
	MessageID string `json:"msgid"`
	BotID     string `json:"aibotid"`
	ChatID    string `json:"chatid"`
	ChatType  string `json:"chattype"`
	From      struct {
		UserID string `json:"userid"`
	} `json:"from"`
	Type  string      `json:"msgtype"`
	Text  *nativeText `json:"text,omitempty"`
	Voice *nativeText `json:"voice,omitempty"`
	Image *resource   `json:"image,omitempty"`
	Video *resource   `json:"video,omitempty"`
	File  *resource   `json:"file,omitempty"`
	Mixed *struct {
		Items []messagePart `json:"msg_item"`
	} `json:"mixed,omitempty"`
	Stream *struct {
		ID string `json:"id"`
	} `json:"stream,omitempty"`
}

func (message nativeMessage) chatID() string {
	if message.ChatType == "single" {
		return message.From.UserID
	}
	return message.ChatID
}

func (c *Channel) receiveResource(ctx context.Context, resource resource, kind model.MediaKind, fallback string) (model.MediaUpload, error) {
	var media model.MediaUpload
	download, err := common.Download(ctx, resource.URL, common.DownloadOptions{MaxBytes: common.MediaLimit(c.host) + 32, TLSClientConfig: c.options.TLSClientConfig})
	if err != nil {
		return media, err
	}
	key := resource.AESKey
	if key == "" {
		key = fallback
	}
	data, err := DecryptFile(download.Data, key)
	if err != nil {
		return media, err
	}
	if int64(len(data)) > common.MediaLimit(c.host) {
		return media, errors.New("media_too_large")
	}
	mimeType := http.DetectContentType(data)
	if kind != model.File && (mimeType == "application/octet-stream" || len(data) == 0) {
		return media, errors.New("unsupported_media_format")
	}
	filename := resource.FileName
	if filename == "" {
		filename = download.FileName
	}
	if filename == "" {
		filename = "attachment"
	}
	return model.MediaUpload{Kind: kind, MIMEType: mimeType, FileName: filename, Data: data}, nil
}

func (c *Channel) receiveParts(ctx context.Context, message nativeMessage) (string, []model.MediaUpload, error) {
	text := ""
	if message.Type == "text" && message.Text != nil {
		text = message.Text.Content
	} else if message.Voice != nil {
		text = message.Voice.Content
	}
	items := []messagePart{{Type: message.Type, Image: message.Image, Video: message.Video, File: message.File}}
	if message.Mixed != nil {
		items = message.Mixed.Items
	}
	var attachments []model.MediaUpload
	fallback := ""
	if c.config.Mode == "webhook" {
		fallback = c.options.SecretValue(c.config.EncodingAESKey)
	}
	for _, item := range items {
		if message.Type == "mixed" && item.Text != nil {
			text += item.Text.Content
		}
		for _, part := range []struct {
			resource *resource
			kind     model.MediaKind
		}{{item.Image, model.Image}, {item.Video, model.Video}, {item.File, model.File}} {
			if part.resource == nil {
				continue
			}
			media, err := c.receiveResource(ctx, *part.resource, part.kind, fallback)
			if common.PolicyRejection(err) {
				return "", nil, nil
			}
			if err != nil {
				return "", nil, err
			}
			attachments = append(attachments, media)
		}
	}
	return text, attachments, nil
}

func (c *Channel) ingest(ctx context.Context, message nativeMessage, requestID string) (bool, error) {
	if message.BotID != c.config.BotID || message.From.UserID == c.config.BotID {
		return false, nil
	}
	if !slices.Contains([]string{"text", "image", "file", "video", "mixed", "voice"}, message.Type) {
		return false, nil
	}
	chatID := message.chatID()
	if chatID == "" || message.MessageID == "" || !slices.Contains([]string{"single", "group"}, message.ChatType) {
		return false, errors.New("invalid_wecom_message")
	}
	if err := c.host.DiscoverConversation(ctx, model.DiscoveredConversation{ChatID: chatID, SenderID: message.From.UserID}); err != nil {
		return false, err
	}
	if !slices.Contains(c.account.AllowedSenders, message.From.UserID) {
		return false, nil
	}
	text, attachments, err := c.receiveParts(ctx, message)
	if err != nil {
		return false, err
	}
	if text == "" && len(attachments) == 0 {
		return false, nil
	}
	target := targetData{ChatType: message.ChatType, CallbackRequestID: requestID}
	target.Scope.BotID = c.config.BotID
	if c.config.Mode == "webhook" {
		target.Scope.Mode = "webhook"
		target.EventID = message.MessageID
		if err = c.startPassive(ctx, streamID(c.config.BotID, message.MessageID), message.MessageID, chatID); err != nil {
			return false, err
		}
	} else {
		target.Scope.WebsocketURL = websocketURL
	}
	_, err = c.host.Ingest(ctx, model.IngestInput{Source: model.SourceKey{Channel: model.WeCom, AccountID: c.account.ID, EventID: message.MessageID}, SenderID: message.From.UserID, Text: text, Attachments: attachments, Target: model.ReplyTarget{Channel: model.WeCom, AccountID: c.account.ID, ChatID: chatID, ReplyToID: message.MessageID, Data: common.Data(target)}, ReceivedAt: time.Now()})
	if common.PolicyRejection(err) {
		return false, nil
	}
	return err == nil, err
}

func (c *Channel) receiveSocket(ctx context.Context, frame frame) error {
	var message nativeMessage
	if json.Unmarshal(frame.Body, &message) != nil {
		return errors.New("invalid_wecom_message")
	}
	_, err := c.ingest(ctx, message, frame.Headers.RequestID)
	return err
}

func (c *Channel) receiveCallback(ctx context.Context, message nativeMessage) (any, error) {
	if message.BotID != c.config.BotID {
		return nil, errors.New("callback_identity_mismatch")
	}
	if message.Type == "stream" {
		if message.Stream == nil || message.Stream.ID == "" || message.chatID() == "" {
			return nil, errors.New("invalid_stream_poll")
		}
		return c.passiveResponse(ctx, message.Stream.ID, message.chatID())
	}
	accepted, err := c.ingest(ctx, message, "")
	if err != nil || !accepted {
		return nil, err
	}
	return c.passiveResponse(ctx, streamID(c.config.BotID, message.MessageID), message.chatID())
}
