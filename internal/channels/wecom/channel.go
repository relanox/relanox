package wecom

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

const websocketURL = "wss://openws.work.weixin.qq.com"

type Config struct {
	Mode           string            `json:"mode,omitempty"`
	BotID          string            `json:"botId"`
	Secret         model.SecretRef   `json:"secret,omitempty"`
	Token          model.SecretRef   `json:"token,omitempty"`
	EncodingAESKey model.SecretRef   `json:"encodingAESKey,omitempty"`
	RecipientTypes map[string]string `json:"recipientTypes,omitempty"`
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var c Config
	if err := common.DecodeConfig(raw, &c); err != nil {
		return c, err
	}
	if c.BotID == "" {
		return c, errors.New("missing_bot_id")
	}
	if c.Mode == "" {
		c.Mode = "websocket"
	}
	if c.Mode == "webhook" {
		if c.Secret.Env != "" || c.Secret.File != "" || c.RecipientTypes != nil {
			return c, errors.New("invalid_webhook_configuration")
		}
		if err := config.ValidateSecretRef(c.Token, "token"); err != nil {
			return c, err
		}
		if err := config.ValidateSecretRef(c.EncodingAESKey, "encodingAESKey"); err != nil {
			return c, err
		}
	} else if c.Mode == "websocket" {
		if c.Token.Env != "" || c.Token.File != "" || c.EncodingAESKey.Env != "" || c.EncodingAESKey.File != "" {
			return c, errors.New("invalid_websocket_configuration")
		}
		if err := config.ValidateSecretRef(c.Secret, "secret"); err != nil {
			return c, err
		}
	} else {
		return c, errors.New("invalid_wecom_mode")
	}
	for id, kind := range c.RecipientTypes {
		if id == "" || !slices.Contains([]string{"single", "group"}, kind) {
			return c, errors.New("invalid_recipient_type")
		}
	}
	return c, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host      model.ChannelHost
	account   model.AccountConfig
	config    Config
	options   common.Options
	lifecycle common.Lifecycle
	mu        sync.Mutex
	active    *socketSession
	closed    bool
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.WeCom || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	c := &Channel{host: host, account: account, config: cfg, options: options}
	if cfg.Mode == "webhook" {
		if err = host.MountHTTP(model.HTTPRoute{Pattern: "/webhook", Handler: http.HandlerFunc(c.callback), MaxBodyBytes: 1024 * 1024}); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.WeCom }

func (c *Channel) Capabilities() model.ChannelCapabilities {
	capabilities := model.ChannelCapabilities{Transport: model.ConnectionTransport, MaxTextLength: 20 * 1024, LengthUnit: model.UTF8, Media: model.MediaCapabilities{Receive: []model.MediaKind{model.Image, model.Video, model.File}, Send: common.AllMedia()}}
	if c.config.Mode == "webhook" {
		// Callback state reserves the delivery and each chunk by durable CAS.
		// Replaying an interrupted lease reads that reservation instead of
		// appending the answer again; socket sends have no such guarantee.
		capabilities.IdempotentSend = true
		capabilities.Transport = model.HTTPTransport
		capabilities.MaxTextLengthPerMessage = 20 * 1024
		capabilities.MaxChunksPerMessage = 11
		capabilities.MaxAttachments = 10
		capabilities.Media.Send = []model.MediaKind{model.Image}
	}
	return capabilities
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitMarkdown(value, 20*1024, model.UTF8)
}

func (c *Channel) Start(ctx context.Context) error {
	c.mu.Lock()
	c.closed = false
	c.mu.Unlock()
	if c.config.Mode == "webhook" {
		return c.lifecycle.Start(ctx, func(ctx context.Context) {
			c.host.Connection(model.Connected, "")
			<-ctx.Done()
			c.host.Connection(model.Disconnected, "")
		})
	}
	return c.lifecycle.Start(ctx, c.connect)
}

func (c *Channel) Close(ctx context.Context) error {
	c.mu.Lock()
	c.closed = true
	active := c.active
	c.mu.Unlock()
	if active != nil {
		_ = active.conn.CloseNow()
	}
	err := c.lifecycle.Close(ctx)
	c.host.Connection(model.Disconnected, "")
	return err
}

type targetData struct {
	ChatType          string `json:"chattype"`
	CallbackRequestID string `json:"callbackReqId,omitempty"`
	EventID           string `json:"eventId,omitempty"`
	Scope             struct {
		BotID        string `json:"botId"`
		WebsocketURL string `json:"wsUrl,omitempty"`
		Mode         string `json:"mode,omitempty"`
	} `json:"scope"`
}

func (c *Channel) valid(data targetData) bool {
	if data.Scope.BotID != c.config.BotID || !slices.Contains([]string{"single", "group"}, data.ChatType) {
		return false
	}
	if c.config.Mode == "webhook" {
		return data.Scope.Mode == "webhook" && data.Scope.WebsocketURL == "" && data.EventID != ""
	}
	return (data.Scope.Mode == "" || data.Scope.Mode == "websocket") && data.Scope.WebsocketURL == websocketURL
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.WeCom || address.AccountID != c.account.ID || address.ChatID == "" || address.ThreadID != "" {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	var data targetData
	known := c.learnedTarget(address, learned, &data)
	if learned != nil && !known {
		return model.ChannelResolution{Reason: "target_identity_changed"}, nil
	}
	if c.config.Mode == "webhook" {
		if !known {
			return model.ChannelResolution{Reason: "address_unresolved"}, nil
		}
		reason, err := c.passiveAvailability(ctx, streamID(c.config.BotID, data.EventID), data.EventID, address.ChatID)
		if err != nil {
			return model.ChannelResolution{}, err
		}
		if reason != "" {
			return model.ChannelResolution{Reason: reason}, nil
		}
	} else {
		kind := c.config.RecipientTypes[address.ChatID]
		if known && kind != "" && kind != data.ChatType {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		if kind == "" && known {
			kind = data.ChatType
		}
		if kind == "" {
			return model.ChannelResolution{Reason: "address_unresolved"}, nil
		}
		if !known || data.ChatType != kind {
			data = targetData{ChatType: kind}
			known = false
		}
		data.Scope.BotID = c.config.BotID
		data.Scope.WebsocketURL = websocketURL
	}
	target := model.ReplyTarget{Channel: model.WeCom, AccountID: c.account.ID, ChatID: address.ChatID, Data: common.Data(data)}
	if known {
		target.ReplyToID = learned.ReplyToID
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

func (c *Channel) learnedTarget(address model.ChannelAddress, learned *model.ReplyTarget, data *targetData) bool {
	return learned != nil && learned.Channel == model.WeCom && learned.AccountID == c.account.ID && learned.ChatID == address.ChatID && learned.ThreadID == "" && json.Unmarshal(learned.Data, data) == nil && c.valid(*data)
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	var target targetData
	if input.Target.Channel != model.WeCom || input.Target.AccountID != c.account.ID || input.Target.ThreadID != "" || json.Unmarshal(input.Target.Data, &target) != nil || !c.valid(target) {
		return common.Reject("invalid_target"), nil
	}
	if c.config.Mode == "webhook" {
		return c.sendPassive(ctx, target, input)
	}
	c.mu.Lock()
	session := c.active
	c.mu.Unlock()
	if session == nil {
		return common.Retry("not_connected", time.Second), nil
	}
	if input.Reply != nil && target.CallbackRequestID == "" {
		return common.Reject("reply_context_unavailable"), nil
	}
	if input.Chunk.Media != nil && input.Media == nil {
		return common.Reject("missing_media"), nil
	}
	var body map[string]any
	if input.Media != nil {
		mediaID, err := session.upload(ctx, *input.Media)
		if err != nil {
			return socketFailure(err, true), nil
		}
		kind := string(input.Media.Reference.Kind)
		if kind == "audio" {
			kind = "voice"
		}
		media := map[string]any{"media_id": mediaID}
		if kind == "video" {
			media["description"] = input.Chunk.Text
		}
		body = map[string]any{"msgtype": kind, kind: media}
	} else if input.Reply != nil {
		body = map[string]any{"msgtype": "stream", "stream": map[string]any{"id": input.Chunk.IdempotencyKey, "content": input.Chunk.Text, "finish": true}}
	} else {
		body = map[string]any{"msgtype": "markdown", "markdown": map[string]string{"content": input.Chunk.Text}}
	}
	command, id := "aibot_send_msg", ""
	if input.Reply != nil {
		command, id = "aibot_respond_msg", target.CallbackRequestID
	} else {
		body["chatid"] = input.Target.ChatID
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	if _, err := session.call(ctx, command, id, body); err != nil {
		return socketFailure(err, false), nil
	}
	return common.Sent(""), nil
}

func (c *Channel) sendPassive(ctx context.Context, target targetData, input model.SendInput) (model.SendResult, error) {
	if input.Target.ReplyToID != "" && target.EventID != input.Target.ReplyToID {
		return common.Reject("target_identity_changed"), nil
	}
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return common.Retry("callback_stopped", 0), nil
	}
	return c.stagePassive(ctx, streamID(c.config.BotID, target.EventID), target.EventID, input)
}

func (c *Channel) callback(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		w.WriteHeader(503)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	crypto, err := NewCallbackCrypto(c.options.SecretValue(c.config.Token), c.options.SecretValue(c.config.EncodingAESKey), "")
	if err != nil {
		w.WriteHeader(503)
		return
	}
	encrypted := r.URL.Query().Get("echostr")
	if r.Method == http.MethodPost {
		raw, err := common.ReadBounded(r.Body, 1024*1024)
		if err != nil {
			w.WriteHeader(413)
			return
		}
		var envelope struct {
			Encrypt string `json:"encrypt"`
		}
		if json.Unmarshal(raw, &envelope) != nil || envelope.Encrypt == "" {
			w.WriteHeader(400)
			return
		}
		encrypted = envelope.Encrypt
	}
	if !crypto.Verify(r.URL.Query(), encrypted, time.Now()) {
		w.WriteHeader(401)
		return
	}
	plain, err := crypto.Decrypt(encrypted)
	if err != nil {
		w.WriteHeader(400)
		return
	}
	if r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "text/plain")
		// The response may already be committed; write failures cannot be retried.
		_, _ = w.Write(plain)
		return
	}
	var message nativeMessage
	if json.Unmarshal(plain, &message) != nil {
		w.WriteHeader(400)
		return
	}
	c.replyCallback(w, r, crypto, message)
}

func (c *Channel) replyCallback(w http.ResponseWriter, r *http.Request, crypto *CallbackCrypto, message nativeMessage) {
	reply, err := c.receiveCallback(r.Context(), message)
	if err != nil {
		w.WriteHeader(503)
		return
	}
	if reply == nil {
		w.WriteHeader(200)
		return
	}
	timestamp, nonce := strconv.FormatInt(time.Now().Unix(), 10), common.RandomID()
	ciphertext, signature, err := crypto.Encrypt(common.Data(reply.body), timestamp, nonce)
	if err != nil {
		w.WriteHeader(503)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	raw := append(common.Data(map[string]string{"encrypt": ciphertext, "msgsignature": signature, "timestamp": timestamp, "nonce": nonce}), '\n')
	if written, err := w.Write(raw); err != nil || written != len(raw) {
		// A failed or partial transmission leaves the final delivery pending.
		return
	}
	if err := c.confirmPassive(r.Context(), reply); err != nil {
		// Output is already committed. A fenced or failed confirmation remains
		// pending; the same native stream can be retrieved again safely.
		return
	}
}
