package matrix

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func validMXC(value id.ContentURIString) (id.ContentURI, error) {
	uri, err := value.Parse()
	if err != nil || uri.IsEmpty() || !id.IsValidMediaID(uri.FileID) {
		return uri, errors.New("invalid_media_uri")
	}
	server, err := url.Parse("https://" + uri.Homeserver)
	if err != nil || server.Host != uri.Homeserver || server.User != nil || server.RawQuery != "" || server.Fragment != "" || server.Path != "" {
		return uri, errors.New("invalid_media_uri")
	}
	return uri, nil
}

func (c *Channel) receive(ctx context.Context, client *mautrix.Client, roomID string, message *event.Event) error {
	if message.Type != event.EventMessage || message.Sender == client.UserID || !slices.Contains(c.account.AllowedSenders, string(message.Sender)) {
		return nil
	}
	var content event.MessageEventContent
	if json.Unmarshal(message.Content.VeryRaw, &content) != nil {
		return errors.New("invalid_native_content")
	}
	if content.File != nil {
		return nil
	}
	threadID := ""
	if relation := content.RelatesTo; relation != nil {
		switch relation.Type {
		case event.RelThread, "io.element.thread":
			if !platformID(string(relation.EventID)) {
				return errors.New("invalid_thread_id")
			}
			threadID = string(relation.EventID)
		case "":
		default:
			return nil
		}
	}
	value := content.Body
	var attachments []model.MediaUpload
	if content.MsgType != event.MsgText {
		media, err := c.download(ctx, client, content)
		if err != nil {
			return err
		}
		if media == nil {
			return nil
		}
		attachments = []model.MediaUpload{*media}
		value = content.GetCaption()
	}
	if value == "" && len(attachments) == 0 {
		return nil
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.Matrix, AccountID: c.account.ID, EventID: string(message.ID)}, SenderID: string(message.Sender), Text: value, Attachments: attachments, ReceivedAt: time.UnixMilli(message.Timestamp), Target: model.ReplyTarget{Channel: model.Matrix, AccountID: c.account.ID, ChatID: roomID, ThreadID: threadID, ReplyToID: string(message.ID), Data: common.Data(c.target(client))}})
}

var mediaTypes = map[event.MessageType]model.MediaKind{event.MsgImage: model.Image, event.MsgAudio: model.Audio, event.MsgVideo: model.Video, event.MsgFile: model.File}

func (c *Channel) download(ctx context.Context, client *mautrix.Client, content event.MessageEventContent) (*model.MediaUpload, error) {
	kind, ok := mediaTypes[content.MsgType]
	if !ok {
		return nil, nil
	}
	maximum := common.MediaLimit(c.host)
	if content.Info != nil && (content.Info.Size < 0 || int64(content.Info.Size) > maximum) {
		return nil, errors.New("media_too_large")
	}
	uri, err := validMXC(content.URL)
	if err != nil {
		return nil, err
	}
	response, err := client.Download(quiet(ctx), uri)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.ContentLength > maximum {
		return nil, errors.New("media_too_large")
	}
	data, err := common.ReadBounded(response.Body, maximum)
	if err != nil {
		return nil, err
	}
	mimeType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	name := content.GetFileName()
	if name == "" {
		name = "attachment.bin"
	}
	upload := &model.MediaUpload{Kind: kind, MIMEType: mimeType, FileName: name, Data: data}
	if content.Info != nil {
		if content.Info.MimeType != "" {
			upload.MIMEType = content.Info.MimeType
		}
		if content.Info.Duration > 0 {
			duration := int64(content.Info.Duration)
			upload.DurationMS = &duration
		}
	}
	return upload, nil
}

func (c *Channel) upload(ctx context.Context, client *mautrix.Client, media model.StoredMedia) (id.ContentURIString, error) {
	if len(media.Data) == 0 || int64(len(media.Data)) != media.Reference.Size || int64(len(media.Data)) > common.MediaLimit(c.host) {
		return "", errors.New("invalid_media")
	}
	response, err := client.UploadBytesWithName(quiet(ctx), media.Data, media.Reference.MIMEType, media.Reference.FileName)
	if err != nil {
		return "", err
	}
	if response == nil {
		return "", errors.New("invalid_upload_response")
	}
	value := response.ContentURI.CUString()
	if _, err = validMXC(value); err != nil {
		return "", err
	}
	return value, nil
}

func (c *Channel) content(ctx context.Context, client *mautrix.Client, input model.SendInput) (*event.MessageEventContent, error) {
	if len(input.Chunk.RichText) > 0 {
		return c.rich(ctx, client, input)
	}
	if input.Chunk.Media == nil {
		return &event.MessageEventContent{MsgType: event.MsgText, Body: text.Plain(input.Chunk.Text), Format: event.FormatHTML, FormattedBody: text.Matrix(input.Chunk.Text)}, nil
	}
	if input.Media == nil || input.Media.Reference.ID != input.Chunk.Media.ID {
		return nil, errors.New("invalid_media")
	}
	uri, err := c.upload(ctx, client, *input.Media)
	if err != nil {
		return nil, err
	}
	ref := input.Media.Reference
	messageType := event.MessageType("")
	for native, kind := range mediaTypes {
		if kind == ref.Kind {
			messageType = native
			break
		}
	}
	if messageType == "" {
		return nil, errors.New("invalid_media")
	}
	content := &event.MessageEventContent{MsgType: messageType, Body: ref.FileName, FileName: ref.FileName, URL: uri, Info: &event.FileInfo{MimeType: ref.MIMEType, Size: len(input.Media.Data)}}
	if input.Chunk.Text != "" {
		content.Body = text.Plain(input.Chunk.Text)
		content.Format = event.FormatHTML
		content.FormattedBody = text.Matrix(input.Chunk.Text)
	}
	if ref.DurationMS != nil {
		content.Info.Duration = int(*ref.DurationMS)
	}
	if input.Preview != nil {
		preview, err := c.upload(ctx, client, *input.Preview)
		if err != nil {
			return nil, err
		}
		content.Info.ThumbnailURL = preview
		content.Info.ThumbnailInfo = &event.FileInfo{MimeType: input.Preview.Reference.MIMEType, Size: len(input.Preview.Data)}
	}
	return content, nil
}

func (c *Channel) rich(ctx context.Context, client *mautrix.Client, input model.SendInput) (*event.MessageEventContent, error) {
	var plain, formatted strings.Builder
	image := 0
	for _, part := range input.Chunk.RichText {
		if part.Type == "text" {
			plain.WriteString(text.Plain(part.Text))
			formatted.WriteString(text.Matrix(part.Text))
			continue
		}
		if part.Media == nil || image >= len(input.RichMedia) {
			return nil, errors.New("invalid_media")
		}
		uri, err := c.upload(ctx, client, input.RichMedia[image])
		if err != nil {
			return nil, err
		}
		image++
		label := part.Label
		if label == "" {
			label = part.Media.FileName
		}
		plain.WriteString(label)
		formatted.WriteString(`<p><img src="` + html.EscapeString(string(uri)) + `" alt="` + html.EscapeString(label) + `" /></p>`)
	}
	return &event.MessageEventContent{MsgType: event.MsgText, Body: plain.String(), Format: event.FormatHTML, FormattedBody: formatted.String()}, nil
}
