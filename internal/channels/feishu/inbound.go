package feishu

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/channel/normalize"
	larktypes "github.com/larksuite/oapi-sdk-go/v3/channel/types"
	larkevent "github.com/larksuite/oapi-sdk-go/v3/event"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type mention struct {
	Key  string `json:"key"`
	Name string `json:"name,omitempty"`
	ID   struct {
		OpenID string `json:"open_id,omitempty"`
	} `json:"id"`
}

type nativeMessage struct {
	ID        string    `json:"message_id"`
	ChatID    string    `json:"chat_id"`
	ChatType  string    `json:"chat_type"`
	Type      string    `json:"message_type"`
	Content   string    `json:"content"`
	CreatedAt string    `json:"create_time"`
	Mentions  []mention `json:"mentions,omitempty"`
	RootID    string    `json:"root_id,omitempty"`
	ParentID  string    `json:"parent_id,omitempty"`
	ThreadID  string    `json:"thread_id,omitempty"`
}

type nativeEvent struct {
	Schema string `json:"schema"`
	Header struct {
		ID        string `json:"event_id"`
		Type      string `json:"event_type"`
		AppID     string `json:"app_id"`
		TenantKey string `json:"tenant_key"`
		Token     string `json:"token"`
	} `json:"header"`
	Event struct {
		Sender struct {
			Type string `json:"sender_type"`
			ID   struct {
				OpenID string `json:"open_id"`
			} `json:"sender_id"`
			TenantKey string `json:"tenant_key,omitempty"`
		} `json:"sender"`
		Message nativeMessage `json:"message"`
	} `json:"event"`
}

func equal(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

func (c *Channel) webhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	raw, err := common.ReadBounded(r.Body, 1024*1024)
	if err != nil {
		w.WriteHeader(413)
		return
	}
	secret, err := c.options.Secret(c.config.EncryptKey)
	if err != nil {
		w.WriteHeader(503)
		return
	}
	signature := r.Header.Get("x-lark-signature")
	if signature != "" {
		timestamp, nonce := r.Header.Get("x-lark-request-timestamp"), r.Header.Get("x-lark-request-nonce")
		seconds, err := strconv.ParseInt(timestamp, 10, 64)
		if err != nil || nonce == "" || len(nonce) > 256 || time.Since(time.Unix(seconds, 0)).Abs() > 5*time.Minute || !equal(signature, larkevent.Signature(timestamp, nonce, secret, string(raw))) {
			w.WriteHeader(401)
			return
		}
	}
	var envelope struct {
		Encrypt string `json:"encrypt"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		w.WriteHeader(400)
		return
	}
	if envelope.Encrypt != "" {
		raw, err = larkevent.EventDecrypt(envelope.Encrypt, secret)
		if err != nil {
			w.WriteHeader(400)
			return
		}
	}
	var challenge struct {
		Type      string `json:"type"`
		Token     string `json:"token"`
		Challenge string `json:"challenge"`
	}
	if json.Unmarshal(raw, &challenge) != nil {
		w.WriteHeader(400)
		return
	}
	verification, err := c.options.Secret(c.config.VerificationToken)
	if err != nil {
		w.WriteHeader(503)
		return
	}
	if challenge.Type == "url_verification" {
		if challenge.Challenge == "" || !equal(challenge.Token, verification) {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"challenge": challenge.Challenge})
		return
	}
	if signature == "" {
		w.WriteHeader(401)
		return
	}
	c.receiveEvent(w, r, raw, verification)
}

func (c *Channel) receiveEvent(w http.ResponseWriter, r *http.Request, raw []byte, verification string) {
	var event nativeEvent
	if json.Unmarshal(raw, &event) != nil || event.Schema != "2.0" || event.Header.ID == "" {
		w.WriteHeader(400)
		return
	}
	if event.Header.AppID != c.config.AppID || event.Header.TenantKey != c.config.TenantKey || !equal(event.Header.Token, verification) || (event.Event.Sender.TenantKey != "" && event.Event.Sender.TenantKey != c.config.TenantKey) {
		w.WriteHeader(401)
		return
	}
	if event.Header.Type != "im.message.receive_v1" {
		w.WriteHeader(200)
		return
	}
	if event.Event.Sender.Type != "user" || !common.Contains(c.account.AllowedSenders, event.Event.Sender.ID.OpenID) {
		w.WriteHeader(200)
		return
	}
	if err := c.receive(r.Context(), event); err != nil {
		_ = c.failure(err, true)
		if common.PolicyRejection(err) {
			w.WriteHeader(200)
		} else {
			w.WriteHeader(503)
		}
		return
	}
	w.WriteHeader(200)
}

// The Go SDK expects localized post content, whereas native events may omit the
// locale envelope. Preserve both documented forms. Mention keys are resolved in
// supplied native order, matching the current official Node normalization API.
// https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content
// https://github.com/larksuite/node-sdk/tree/e34a66f0d20935ee77f94909d16d93292d58b6c7
func normalizeContent(message nativeMessage, botID string) (string, []larktypes.Resource, error) {
	content := message.Content
	if message.Type == "post" {
		var post map[string]any
		if json.Unmarshal([]byte(content), &post) != nil {
			return "", nil, errors.New("invalid_native_content")
		}
		if _, direct := post["content"]; direct {
			post = map[string]any{"zh_cn": post}
		}
		if _, direct := post["content_v2"]; direct {
			post = map[string]any{"zh_cn": post}
		}
		for _, localized := range post {
			body, ok := localized.(map[string]any)
			if !ok {
				continue
			}
			postMentions(body, message.Mentions)
		}
		content = string(common.Data(post))
	}
	text, resources := normalize.ParseContent(message.Type, content)
	for _, mention := range message.Mentions {
		if mention.Key == "" {
			continue
		}
		name := mention.Name
		if name == "" {
			name = mention.ID.OpenID
		}
		replacement := "@" + name
		if mention.ID.OpenID == botID {
			replacement = ""
		}
		text = strings.ReplaceAll(text, mention.Key, replacement)
	}
	return strings.TrimSpace(text), resources, nil
}

func postMentions(body map[string]any, mentions []mention) {
	for _, field := range []string{"content", "content_v2"} {
		rows, _ := body[field].([]any)
		for _, row := range rows {
			postRowMentions(row, mentions)
		}
	}
}

func postRowMentions(raw any, mentions []mention) {
	row, _ := raw.([]any)
	for _, rawPart := range row {
		part, _ := rawPart.(map[string]any)
		if part["tag"] != "at" {
			continue
		}
		id, _ := part["user_id"].(string)
		if key := mentionKey(id, mentions); key != "" {
			part["user_name"] = strings.TrimPrefix(key, "@")
		}
	}
}

func mentionKey(id string, mentions []mention) string {
	for _, mention := range mentions {
		if mention.ID.OpenID == id && mention.Key != "" {
			return mention.Key
		}
	}
	return ""
}

func (c *Channel) receive(ctx context.Context, event nativeEvent) error {
	message := event.Event.Message
	if !common.Contains([]string{"text", "image", "audio", "media", "file", "post"}, message.Type) {
		return nil
	}
	if message.ID == "" || message.ChatID == "" || event.Event.Sender.ID.OpenID == "" {
		return errors.New("invalid_native_message")
	}
	botID, err := c.ensureIdentity(ctx)
	if err != nil {
		return err
	}
	if event.Event.Sender.ID.OpenID == botID {
		return nil
	}
	text, resources, err := normalizeContent(message, botID)
	if err != nil {
		return err
	}
	media, err := c.downloadResources(ctx, message.ID, resources)
	if err != nil {
		return err
	}
	if text == "" && len(media) == 0 {
		return nil
	}
	data := c.identity(botID)
	if message.ThreadID != "" {
		data.ThreadAnchor = message.RootID
		if data.ThreadAnchor == "" {
			data.ThreadAnchor = message.ID
		}
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.Feishu, AccountID: c.account.ID, EventID: event.Header.ID}, SenderID: event.Event.Sender.ID.OpenID, Text: text, Attachments: media, Target: model.ReplyTarget{Channel: model.Feishu, AccountID: c.account.ID, ChatID: message.ChatID, ThreadID: message.ThreadID, ReplyToID: message.ID, Data: common.Data(data)}, ReceivedAt: time.Now(), Context: common.Data(map[string]string{"tenantKey": c.config.TenantKey})})
}
