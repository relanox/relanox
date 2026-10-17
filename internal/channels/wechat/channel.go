package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"
	"time"

	ilink "github.com/openilink/openilink-sdk-go"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/relanox/relanox/internal/transport"
)

type Config struct {
	BotID                 string          `json:"botId"`
	BotToken              model.SecretRef `json:"botToken"`
	APIBaseURL            string          `json:"apiBaseUrl,omitempty"`
	CDNBaseURL            string          `json:"cdnBaseUrl,omitempty"`
	AllowInsecureLoopback bool            `json:"allowInsecureLoopback,omitempty"`
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var c Config
	if err := common.DecodeConfig(raw, &c); err != nil {
		return c, err
	}
	if c.BotID == "" || len(c.BotID) > 256 {
		return c, errors.New("invalid_bot_id")
	}
	if err := config.ValidateSecretRef(c.BotToken, "botToken"); err != nil {
		return c, err
	}
	if c.APIBaseURL == "" {
		c.APIBaseURL = "https://ilinkai.weixin.qq.com"
	}
	if c.CDNBaseURL == "" {
		c.CDNBaseURL = "https://novac2c.cdn.weixin.qq.com/c2c"
	}
	for _, endpoint := range []string{c.APIBaseURL, c.CDNBaseURL} {
		if _, err := TransportURL(endpoint, c.AllowInsecureLoopback); err != nil {
			return c, err
		}
	}
	return c, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host      model.ChannelHost
	account   model.AccountConfig
	config    Config
	client    *Client
	lifecycle common.Lifecycle
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.WeChat || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	httpClient := options.HTTPClient
	if httpClient == nil && cfg.AllowInsecureLoopback {
		api, _ := url.Parse(cfg.APIBaseURL)
		cdn, _ := url.Parse(cfg.CDNBaseURL)
		httpClient = transport.NewClient(transport.Options{AllowPrivateHosts: []string{api.Hostname(), cdn.Hostname()}, Timeout: 120 * time.Second})
	}
	return &Channel{host: host, account: account, config: cfg, client: &Client{APIBase: cfg.APIBaseURL, CDNBase: cfg.CDNBaseURL, HTTP: httpClient, Token: func() string { return options.SecretValue(cfg.BotToken) }}}, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.WeChat }

func (c *Channel) Capabilities() model.ChannelCapabilities {
	return model.ChannelCapabilities{Transport: model.ConnectionTransport, MaxTextLength: 4000, LengthUnit: model.Codepoint, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: []model.MediaKind{model.Image, model.Video, model.File}}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitMarkdown(value, 4000, model.Codepoint)
}

func (c *Channel) key(name string) string {
	base, _ := url.Parse(c.config.APIBaseURL)
	return url.QueryEscape(c.config.BotID) + ":" + url.QueryEscape(base.String()) + ":" + name
}

type targetData struct {
	BotID        string `json:"botId"`
	APIBaseURL   string `json:"apiBaseUrl"`
	ContextToken string `json:"contextToken"`
}

func (c *Channel) matches(data targetData) bool {
	return data.BotID == c.config.BotID && data.APIBaseURL == c.config.APIBaseURL && data.ContextToken != ""
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.WeChat || address.AccountID != c.account.ID || address.ChatID == "" || address.ThreadID != "" {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	var prior targetData
	if learned != nil && !c.learnedTarget(address, learned, &prior) {
		return model.ChannelResolution{Reason: "target_identity_changed"}, nil
	}
	data, entry, err := common.ReadState[targetData](ctx, c.host.State(), c.key("context:"+address.ChatID))
	if err != nil {
		return model.ChannelResolution{}, err
	}
	if entry == nil && learned != nil {
		data = prior
	}
	if !c.matches(data) {
		return model.ChannelResolution{Reason: "missing_context"}, nil
	}
	target := model.ReplyTarget{Channel: model.WeChat, AccountID: c.account.ID, ChatID: address.ChatID, Data: common.Data(data)}
	if learned != nil {
		target.ReplyToID = learned.ReplyToID
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

func (c *Channel) learnedTarget(address model.ChannelAddress, learned *model.ReplyTarget, data *targetData) bool {
	return learned.Channel == model.WeChat && learned.AccountID == c.account.ID && learned.ChatID == address.ChatID && learned.ThreadID == address.ThreadID && json.Unmarshal(learned.Data, data) == nil && c.matches(*data)
}

func (c *Channel) accept(ctx context.Context, message Message) error {
	if message.From == "" || message.Type != 1 || message.State == 1 || message.Group != "" || (message.To != "" && message.To != c.config.BotID) {
		return nil
	}
	if err := c.host.DiscoverConversation(ctx, model.DiscoveredConversation{ChatID: message.From, SenderID: message.From}); err != nil {
		return err
	}
	if !slices.Contains(c.account.AllowedSenders, message.From) || message.ContextToken == "" {
		return nil
	}
	id := messageID(message)
	if id == "" {
		return errors.New("wechat_missing_message_id")
	}
	fragments := messageText(message)
	attachments, err := c.client.receiveMedia(ctx, message.Items, common.MediaLimit(c.host), c.config.AllowInsecureLoopback)
	if err != nil {
		return err
	}
	if len(fragments) == 0 && len(attachments) == 0 {
		return nil
	}
	data := targetData{BotID: c.config.BotID, APIBaseURL: c.config.APIBaseURL, ContextToken: message.ContextToken}
	received := time.Now()
	if message.CreatedAt > 0 {
		received = time.UnixMilli(message.CreatedAt)
	}
	if err = common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.WeChat, AccountID: c.account.ID, EventID: id}, SenderID: message.From, Text: strings.Join(fragments, "\n"), Attachments: attachments, Target: model.ReplyTarget{Channel: model.WeChat, AccountID: c.account.ID, ChatID: message.From, ReplyToID: id, Data: common.Data(data)}, ReceivedAt: received}); err != nil {
		return err
	}
	return common.SaveState(ctx, c.host.State(), c.key("context:"+message.From), data, nil)
}

func messageID(message Message) string {
	id := string(message.ID)
	if id == "" {
		for _, item := range message.Items {
			if item.MessageID != "" {
				id = string(item.MessageID)
				break
			}
		}
	}
	if id == "" {
		id = message.ClientID
	}
	return id
}

func messageText(message Message) []string {
	var fragments []string
	for _, item := range message.Items {
		if item.Type == 1 && item.Text != nil && item.Text.Text != "" {
			fragments = append(fragments, item.Text.Text)
		} else if item.Voice != nil && item.Voice.Text != "" {
			fragments = append(fragments, item.Voice.Text)
		}
	}
	return fragments
}

func (c *Channel) poll(ctx context.Context) {
	for ctx.Err() == nil {
		retry := time.Second
		cursor, _, err := common.ReadState[string](ctx, c.host.State(), c.key("cursor"))
		var updates Updates
		if err == nil {
			err = c.client.Post(ctx, "getupdates", map[string]any{"get_updates_buf": cursor}, &updates, 45*time.Second)
		}
		if err == nil {
			for _, message := range updates.Messages {
				if err = c.accept(ctx, message); common.PolicyRejection(err) {
					err = nil
				}
				if err != nil {
					break
				}
			}
			if err == nil && updates.Cursor != "" {
				err = common.SaveState(ctx, c.host.State(), c.key("cursor"), updates.Cursor, nil)
			}
		}
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			c.host.Connection(model.Connected, "")
			continue
		}
		code := "wechat_poll_failed"
		var native *APIError
		if errors.As(err, &native) && native.Code == -14 {
			retry = time.Hour
			code = "wechat_session_expired"
		}
		c.host.Connection(model.Degraded, code)
		if common.Delay(ctx, retry) != nil {
			return
		}
	}
}

func (c *Channel) Start(ctx context.Context) error { return c.lifecycle.Start(ctx, c.poll) }

func (c *Channel) Close(ctx context.Context) error {
	err := c.lifecycle.Close(ctx)
	c.host.Connection(model.Disconnected, "")
	return err
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	var data targetData
	if input.Target.Channel != model.WeChat || input.Target.AccountID != c.account.ID || input.Target.ThreadID != "" || json.Unmarshal(input.Target.Data, &data) != nil || !c.matches(data) {
		return common.Reject("invalid_target"), nil
	}
	item := ilink.MessageItem{Type: ilink.ItemText, TextItem: &ilink.TextItem{Text: input.Chunk.Text}}
	var err error
	if input.Chunk.Media != nil {
		if input.Media == nil {
			return common.Reject("missing_media"), nil
		}
		if input.Media.Reference.Kind == model.Audio {
			return common.Reject("unsupported_media_type"), nil
		}
		item, err = c.client.uploadMedia(ctx, *input.Media, input.Target.ChatID)
		if err != nil {
			return common.Retry("wechat_upload_failed", 0), nil
		}
	}
	if err = ctx.Err(); err != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	message := &ilink.WeixinMessage{ToUserID: input.Target.ChatID, ClientID: input.Chunk.IdempotencyKey, MessageType: ilink.MsgTypeBot, MessageState: ilink.StateFinish, ContextToken: data.ContextToken, ItemList: []ilink.MessageItem{item}}
	err = c.client.send(ctx, message)
	if err == nil {
		receipt := common.Sent("")
		receipt.Receipt.Data = common.Data(map[string]string{"clientId": input.Chunk.IdempotencyKey})
		return receipt, nil
	}
	var native *APIError
	if errors.As(err, &native) {
		if native.Status == 429 {
			return common.Retry("wechat_rate_limited", 0), nil
		}
		if native.Status < 500 {
			if native.Code == -14 {
				return common.Reject("wechat_session_expired"), nil
			}
			return common.Reject("wechat_send_rejected"), nil
		}
	}
	return model.SendResult{Status: model.Unknown, ErrorCode: "wechat_send_unknown"}, nil
}
