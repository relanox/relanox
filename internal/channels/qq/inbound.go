package qq

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type nativeMessage struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
	Type      *int   `json:"message_type,omitempty"`
	Sequence  *int64 `json:"msg_seq,omitempty"`
	GroupID   string `json:"group_openid,omitempty"`
	Author    struct {
		UserID   string `json:"user_openid,omitempty"`
		MemberID string `json:"member_openid,omitempty"`
		Bot      bool   `json:"bot,omitempty"`
	} `json:"author"`
	Attachments []nativeAttachment `json:"attachments,omitempty"`
	Scene       struct {
		Ext []string `json:"ext,omitempty"`
	} `json:"message_scene"`
}

func ownMessageIndex(message nativeMessage) string {
	result := ""
	for _, entry := range message.Scene.Ext {
		key, value, ok := strings.Cut(entry, "=")
		if ok && strings.TrimSpace(key) == "msg_idx" && strings.TrimSpace(value) != "" {
			result = strings.TrimSpace(value)
		}
	}
	return result
}

func eventID(kind string, message nativeMessage, index string) string {
	var part any
	if index != "" {
		part = index
	} else if message.Sequence != nil {
		part = *message.Sequence
	}
	return string(common.Data([]any{kind, message.ID, part}))
}

func supported(message nativeMessage) bool {
	if message.Type != nil && *message.Type != 0 && *message.Type != 7 && *message.Type != 103 {
		return false
	}
	return strings.TrimSpace(message.Content) != "" || len(message.Attachments) > 0
}

func (c *Channel) receive(ctx context.Context, frame gatewayFrame) error {
	var message nativeMessage
	if json.Unmarshal(frame.Data, &message) != nil || !validID(message.ID) || message.Author.Bot || !supported(message) {
		return nil
	}
	kind, sender, chatID := "c2c", message.Author.UserID, message.Author.UserID
	if frame.Type != "C2C_MESSAGE_CREATE" {
		kind = "group"
		sender = message.Author.MemberID
		chatID = message.GroupID
	}
	if !validID(sender) || !validID(chatID) || !common.Contains(c.account.AllowedSenders, sender) {
		return nil
	}
	messageAt, err := time.Parse(time.RFC3339Nano, message.Timestamp)
	if err != nil || messageAt.UnixMilli() < 0 {
		return nil
	}
	attachments, err := c.downloadAttachments(ctx, message.Attachments)
	if err != nil {
		return err
	}
	fragments := []string{message.Content}
	if message.Content == "" {
		fragments = nil
	}
	fragments = append(fragments, attachments.fallbacks...)
	index := ownMessageIndex(message)
	at := messageAt.UnixMilli()
	data := targetData{Type: kind, MessageID: message.ID, MessageIndex: index, MessageAt: &at, Scope: c.identity()}
	input := model.IngestInput{Source: model.SourceKey{Channel: model.QQ, AccountID: c.account.ID, EventID: eventID(frame.Type, message, index)}, SenderID: sender, Text: strings.Join(fragments, "\n"), Attachments: attachments.uploads, Target: model.ReplyTarget{Channel: model.QQ, AccountID: c.account.ID, ChatID: chatID, ReplyToID: message.ID, Data: common.Data(data)}, ReceivedAt: time.Now()}
	if len(attachments.images) > 0 {
		input.Context = common.Data(map[string]any{"remoteImages": attachments.images})
	}
	return common.Ingest(ctx, c.host, input)
}
