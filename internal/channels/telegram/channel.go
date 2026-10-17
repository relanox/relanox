// Package telegram implements the native Telegram Bot API webhook protocol.
package telegram

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/relanox/relanox/internal/transport"
)

type Config struct {
	BotToken              model.SecretRef `json:"botToken"`
	WebhookSecret         model.SecretRef `json:"webhookSecret"`
	APIBaseURL            string          `json:"apiBaseUrl,omitempty"`
	AllowInsecureLoopback bool            `json:"allowInsecureLoopback,omitempty"`
}

var integerID = regexp.MustCompile(`^-?[1-9][0-9]{0,19}$`)
var positiveID = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	for field, ref := range map[string]model.SecretRef{"botToken": cfg.BotToken, "webhookSecret": cfg.WebhookSecret} {
		if err := config.ValidateSecretRef(ref, field); err != nil {
			return cfg, err
		}
	}
	if cfg.APIBaseURL == "" {
		cfg.APIBaseURL = "https://api.telegram.org"
	}
	cfg.APIBaseURL = strings.TrimRight(cfg.APIBaseURL, "/")
	u, err := url.Parse(cfg.APIBaseURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return cfg, errors.New("invalid_api_base_url")
	}
	local := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(cfg.AllowInsecureLoopback && local && u.Scheme == "http") {
		return cfg, errors.New("insecure_api_base_url")
	}
	return cfg, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host      model.ChannelHost
	account   model.AccountConfig
	config    Config
	options   common.Options
	client    *http.Client
	lifecycle common.Lifecycle
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.Telegram || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	client := options.HTTPClient
	if client == nil {
		u, _ := url.Parse(cfg.APIBaseURL)
		client = transport.NewClient(transport.Options{Timeout: 120 * time.Second, AllowPrivateHosts: []string{u.Hostname()}, TLSClientConfig: options.TLSClientConfig})
	}
	c := &Channel{host: host, account: account, config: cfg, options: options, client: client}
	if err = host.MountHTTP(model.HTTPRoute{Pattern: "/webhook", Handler: http.HandlerFunc(c.webhook), MaxBodyBytes: 2 * 1024 * 1024}); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.Telegram }

func (c *Channel) Capabilities() model.ChannelCapabilities {
	return model.ChannelCapabilities{Transport: model.HTTPTransport, MaxTextLength: 4096, LengthUnit: model.Codepoint, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitByRendered(value, 4096, model.Codepoint, func(s string) string { return text.Telegram(s).Text })
}

func (c *Channel) Start(ctx context.Context) error {
	return c.lifecycle.Start(ctx, func(ctx context.Context) {
		c.host.Connection(model.Connected, "")
		<-ctx.Done()
		c.host.Connection(model.Disconnected, "")
	})
}

func (c *Channel) Close(ctx context.Context) error {
	c.client.CloseIdleConnections()
	return c.lifecycle.Close(ctx)
}

type targetData struct {
	BotID      string `json:"botId"`
	APIBaseURL string `json:"apiBaseUrl"`
}

func (c *Channel) identity() (targetData, error) {
	token, err := c.options.Secret(c.config.BotToken)
	if err != nil {
		return targetData{}, err
	}
	bot, _, ok := strings.Cut(token, ":")
	if !ok || !positiveID.MatchString(bot) {
		return targetData{}, errors.New("invalid_bot_token")
	}
	return targetData{BotID: bot, APIBaseURL: c.config.APIBaseURL}, nil
}

func (c *Channel) Resolve(_ context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.Telegram || address.AccountID != c.account.ID || !integerID.MatchString(address.ChatID) || (address.ThreadID != "" && !positiveID.MatchString(address.ThreadID)) {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	identity, err := c.identity()
	if err != nil {
		return model.ChannelResolution{}, err
	}
	target := model.ReplyTarget{Channel: model.Telegram, AccountID: c.account.ID, ChatID: address.ChatID, ThreadID: address.ThreadID, Data: common.Data(identity)}
	if learned != nil {
		var data targetData
		if learned.Channel != model.Telegram || learned.AccountID != c.account.ID || learned.ChatID != address.ChatID || learned.ThreadID != address.ThreadID || json.Unmarshal(learned.Data, &data) != nil || data != identity {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		target.ReplyToID = learned.ReplyToID
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

type file struct {
	ID       string  `json:"file_id"`
	Size     int64   `json:"file_size,omitempty"`
	Name     string  `json:"file_name,omitempty"`
	MIME     string  `json:"mime_type,omitempty"`
	Duration float64 `json:"duration,omitempty"`
}

type message struct {
	ID       json.Number `json:"message_id"`
	ThreadID json.Number `json:"message_thread_id,omitempty"`
	From     *struct {
		ID  json.Number `json:"id"`
		Bot bool        `json:"is_bot"`
	} `json:"from,omitempty"`
	Chat struct {
		ID   json.Number `json:"id"`
		Type string      `json:"type"`
	} `json:"chat"`
	Text      string `json:"text,omitempty"`
	Caption   string `json:"caption,omitempty"`
	Photos    []file `json:"photo,omitempty"`
	Audio     *file  `json:"audio,omitempty"`
	Voice     *file  `json:"voice,omitempty"`
	Video     *file  `json:"video,omitempty"`
	Animation *file  `json:"animation,omitempty"`
	VideoNote *file  `json:"video_note,omitempty"`
	Document  *file  `json:"document,omitempty"`
}

type update struct {
	ID      json.Number `json:"update_id"`
	Message *message    `json:"message,omitempty"`
}

func (c *Channel) webhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	secret, err := c.options.Secret(c.config.WebhookSecret)
	if err != nil || secret == "" || subtle.ConstantTimeCompare([]byte(secret), []byte(r.Header.Get("X-Telegram-Bot-Api-Secret-Token"))) != 1 {
		w.WriteHeader(401)
		return
	}
	raw, err := common.ReadBounded(r.Body, 2*1024*1024)
	if err != nil {
		w.WriteHeader(413)
		return
	}
	var event update
	if json.Unmarshal(raw, &event) != nil || (event.ID.String() != "0" && !positiveID.MatchString(event.ID.String())) {
		w.WriteHeader(400)
		return
	}
	if event.Message == nil {
		w.WriteHeader(200)
		return
	}
	m := event.Message
	if !positiveID.MatchString(m.ID.String()) || !integerID.MatchString(m.Chat.ID.String()) || (m.ThreadID.String() != "" && !positiveID.MatchString(m.ThreadID.String())) {
		w.WriteHeader(400)
		return
	}
	if m.From == nil || m.From.Bot || m.Chat.Type == "channel" || !slices.Contains(c.account.AllowedSenders, m.From.ID.String()) {
		w.WriteHeader(200)
		return
	}
	if err = c.receive(r.Context(), event); err != nil && !common.PolicyRejection(err) {
		w.WriteHeader(503)
		return
	}
	w.WriteHeader(200)
}

func (c *Channel) receive(ctx context.Context, event update) error {
	m := event.Message
	media, err := c.download(ctx, *m)
	if err != nil {
		return err
	}
	value := m.Text
	if value == "" {
		value = m.Caption
	}
	if value == "" && len(media) == 0 {
		return nil
	}
	identity, err := c.identity()
	if err != nil {
		return err
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.Telegram, AccountID: c.account.ID, EventID: event.ID.String()}, SenderID: m.From.ID.String(), Text: value, Attachments: media, Target: model.ReplyTarget{Channel: model.Telegram, AccountID: c.account.ID, ChatID: m.Chat.ID.String(), ThreadID: m.ThreadID.String(), ReplyToID: m.ID.String(), Data: common.Data(identity)}, ReceivedAt: time.Now()})
}
