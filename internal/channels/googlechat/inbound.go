package googlechat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	chat "google.golang.org/api/chat/v1"
)

// ArgumentText is optional; an explicit empty string must not fall back to text.
type incomingMessage struct {
	chat.Message
	ArgumentText *string `json:"argumentText"`
}

type event struct {
	Type    string           `json:"type"`
	Space   *chat.Space      `json:"space"`
	Message *incomingMessage `json:"message"`
}

func (c *Channel) webhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	// Also enforce authentication for hosts mounting the handler directly.
	if c.authorize(r) != nil {
		w.WriteHeader(401)
		return
	}
	raw, err := common.ReadBounded(r.Body, 2<<20)
	var input event
	if err != nil || json.Unmarshal(raw, &input) != nil {
		w.WriteHeader(400)
		return
	}
	if err = c.receive(r.Context(), input); err != nil && !common.PolicyRejection(err) {
		w.WriteHeader(503)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("{}"))
}

func (c *Channel) receive(ctx context.Context, input event) error {
	if input.Type != "MESSAGE" || input.Space == nil || input.Message == nil {
		return nil
	}
	m := input.Message
	if !c.allowedSender(m.Sender) {
		return nil
	}
	thread := ""
	if m.Thread != nil {
		thread = m.Thread.Name
	}
	if !validAddress(input.Space.Name, thread) || !messageID.MatchString(m.Name) || !strings.HasPrefix(m.Name, input.Space.Name+"/messages/") {
		return errors.New("invalid_native_message")
	}
	if err := c.host.DiscoverConversation(ctx, model.DiscoveredConversation{ChatID: input.Space.Name, ThreadID: thread, SenderID: m.Sender.Name}); err != nil {
		return err
	}
	if !slices.Contains(c.host.BoundChatIDs(), input.Space.Name) {
		return nil
	}
	value := m.Text
	if m.ArgumentText != nil {
		value = *m.ArgumentText
	}
	if value == "" && len(m.Attachment) == 0 {
		return nil
	}
	media, err := c.download(ctx, input.Space.Name, m.Attachment)
	if err != nil {
		return err
	}
	credentials, _, err := c.credentials()
	if err != nil {
		return err
	}
	data := targetData{Space: input.Space.Name, Thread: thread, Scope: scope{ClientEmail: credentials.Email, APIBase: apiOrigin}}
	updated := m.LastUpdateTime
	if updated == "" {
		updated = m.CreateTime
	}
	quote := &chat.QuotedMessageMetadata{Name: m.Name, LastUpdateTime: updated}
	if validQuote(quote, input.Space.Name) {
		data.Quote = quote
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.GoogleChat, AccountID: c.account.ID, EventID: m.Name}, SenderID: m.Sender.Name, Text: value, Attachments: media, Target: model.ReplyTarget{Channel: model.GoogleChat, AccountID: c.account.ID, ChatID: data.Space, ThreadID: thread, ReplyToID: m.Name, Data: common.Data(data)}, ReceivedAt: time.Now()})
}

func (c *Channel) allowedSender(sender *chat.User) bool {
	return sender != nil && sender.Type != "BOT" && userID.MatchString(sender.Name) && slices.Contains(c.account.AllowedSenders, sender.Name)
}

func (c *Channel) download(ctx context.Context, space string, attachments []*chat.Attachment) ([]model.MediaUpload, error) {
	if len(attachments) > 10 {
		return nil, errors.New("too_many_attachments")
	}
	result := make([]model.MediaUpload, 0, len(attachments))
	for _, attachment := range attachments {
		media, err := c.downloadOne(ctx, space, attachment)
		if err != nil {
			return nil, err
		}
		result = append(result, media)
	}
	return result, nil
}

func (c *Channel) downloadOne(ctx context.Context, space string, attachment *chat.Attachment) (model.MediaUpload, error) {
	var result model.MediaUpload
	if attachment == nil || attachment.AttachmentDataRef == nil {
		return result, errors.New("unsupported_attachment_reference")
	}
	name := attachment.AttachmentDataRef.ResourceName
	if !strings.HasPrefix(name, space+"/") || len(name) > 2048 || strings.Contains(name, "..") || strings.ContainsAny(name, "\\%?#\r\n") {
		return result, errors.New("unsupported_attachment_reference")
	}
	token, err := c.accessToken(ctx)
	if err != nil {
		return result, err
	}
	call := c.service.Media.Download(name).Context(ctx)
	call.Header().Set("Authorization", "Bearer "+token)
	response, err := call.Download()
	if err != nil {
		c.invalidateToken(err)
		return result, errors.New("media_download_failed")
	}
	defer response.Body.Close()
	if response.ContentLength > common.MediaLimit(c.host) {
		return result, errors.New("media_too_large")
	}
	raw, err := common.ReadBounded(response.Body, common.MediaLimit(c.host))
	if err != nil {
		return result, err
	}
	mimeType := attachment.ContentType
	if mimeType == "" {
		mimeType = strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	name = attachment.ContentName
	if name == "" {
		name = "attachment.bin"
	}
	return model.MediaUpload{Data: raw, MIMEType: mimeType, Kind: common.MediaKind(mimeType), FileName: name}, nil
}
