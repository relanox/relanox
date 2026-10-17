// Package qq implements native QQ group/C2C gateway and HTTP protocols.
package qq

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/relanox/relanox/internal/transport"
)

type Config struct {
	AppID          string            `json:"appId"`
	ClientSecret   model.SecretRef   `json:"clientSecret"`
	Environment    string            `json:"environment,omitempty"`
	RecipientTypes map[string]string `json:"recipientTypes,omitempty"`
	// Explicit administrator trust for enterprise upload endpoints. Native
	// response URLs alone never grant private-network access.
	TrustedUploadOrigins []string `json:"trustedUploadOrigins,omitempty"`
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	if cfg.AppID == "" || len(cfg.AppID) > 256 {
		return cfg, errors.New("invalid_qq_app_id")
	}
	if err := config.ValidateSecretRef(cfg.ClientSecret, "clientSecret"); err != nil {
		return cfg, err
	}
	if cfg.Environment == "" {
		cfg.Environment = "production"
	}
	if cfg.Environment != "production" && cfg.Environment != "sandbox" {
		return cfg, errors.New("invalid_qq_environment")
	}
	for id, kind := range cfg.RecipientTypes {
		if !validID(id) || !validKind(kind) {
			return cfg, errors.New("invalid_recipient_type")
		}
	}
	for _, origin := range cfg.TrustedUploadOrigins {
		if !safeHTTPS(origin) || common.Origin(origin) != origin {
			return cfg, errors.New("invalid_trusted_upload_origin")
		}
	}
	return cfg, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host              model.ChannelHost
	account           model.AccountConfig
	config            Config
	options           common.Options
	tokens            common.TokenCache
	lifecycle         common.Lifecycle
	uploadHTTP        *http.Client
	trustedUploadHTTP *http.Client
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.QQ || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	policy := transport.Options{Timeout: 120 * time.Second, TLSClientConfig: options.TLSClientConfig}
	uploadHTTP := transport.NewClient(policy)
	for _, origin := range cfg.TrustedUploadOrigins {
		u, _ := url.Parse(origin)
		policy.AllowPrivateHosts = append(policy.AllowPrivateHosts, u.Hostname())
	}
	return &Channel{host: host, account: account, config: cfg, options: options, uploadHTTP: uploadHTTP, trustedUploadHTTP: transport.NewClient(policy)}, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.QQ }

var richLimits = model.RichTextLimits{MaxParts: 20, MaxTextLength: 1000, ImageMIMETypes: []string{"image/png", "image/jpeg"}, MaxImageBytes: 20 * 1024 * 1024}

func (c *Channel) Capabilities() model.ChannelCapabilities {
	result := model.ChannelCapabilities{Transport: model.ConnectionTransport, MaxTextLength: 2000, LengthUnit: model.UTF8, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
	if c.host.Media() != nil && strings.HasPrefix(c.host.PublicURL(), "https://") {
		limits := richLimits
		result.RichText = &limits
	}
	return result
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitMarkdown(value, 2000, model.UTF8)
}

func (c *Channel) Start(ctx context.Context) error { return c.lifecycle.Start(ctx, c.connect) }

func (c *Channel) Close(ctx context.Context) error {
	err := c.lifecycle.Close(ctx)
	c.uploadHTTP.CloseIdleConnections()
	c.trustedUploadHTTP.CloseIdleConnections()
	c.host.Connection(model.Disconnected, "")
	return err
}

func (c *Channel) base() string {
	if c.config.Environment == "sandbox" {
		return "https://sandbox.api.sgroup.qq.com"
	}
	return "https://api.sgroup.qq.com"
}

func validKind(kind string) bool { return kind == "c2c" || kind == "group" }

func validID(id string) bool {
	return id != "" && len(id) <= 1024 && !strings.ContainsAny(id, "\x00\r\n")
}

func safeHTTPS(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Fragment == ""
}

type identity struct {
	AppID   string `json:"appId"`
	APIBase string `json:"apiBase"`
}

type targetData struct {
	Type         string   `json:"type"`
	MessageID    string   `json:"msgId,omitempty"`
	MessageIndex string   `json:"msgIdx,omitempty"`
	MessageAt    *int64   `json:"messageAt,omitempty"`
	Scope        identity `json:"scope"`
}

func (c *Channel) identity() identity {
	return identity{AppID: c.config.AppID, APIBase: c.base() + "/"}
}

func (c *Channel) valid(target targetData) bool {
	return target.Scope == c.identity() && validKind(target.Type) && ((target.MessageID == "") == (target.MessageAt == nil)) && (target.MessageAt == nil || *target.MessageAt >= 0)
}

func (c *Channel) learned(address model.ChannelAddress, target *model.ReplyTarget, data *targetData) bool {
	return target != nil && target.Channel == model.QQ && target.AccountID == c.account.ID && target.ChatID == address.ChatID && target.ThreadID == "" && json.Unmarshal(target.Data, data) == nil && c.valid(*data)
}

func (c *Channel) Resolve(_ context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.QQ || address.AccountID != c.account.ID || !validID(address.ChatID) || address.ThreadID != "" {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	var data targetData
	known := c.learned(address, learned, &data)
	if learned != nil && !known {
		return model.ChannelResolution{Reason: "target_identity_changed"}, nil
	}
	kind := c.config.RecipientTypes[address.ChatID]
	if known && kind != "" && kind != data.Type {
		return model.ChannelResolution{Reason: "target_identity_changed"}, nil
	}
	if kind == "" && known {
		kind = data.Type
	}
	if kind == "" {
		return model.ChannelResolution{Reason: "address_unresolved"}, nil
	}
	if !known || data.Type != kind {
		data = targetData{Type: kind, Scope: c.identity()}
	}
	target := model.ReplyTarget{Channel: model.QQ, AccountID: c.account.ID, ChatID: address.ChatID, Data: common.Data(data)}
	if known && data.MessageID != "" {
		target.ReplyToID = data.MessageID
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

func (c *Channel) sendTarget(input model.SendInput, data *targetData) bool {
	return input.Target.Channel == model.QQ && input.Target.AccountID == c.account.ID && validID(input.Target.ChatID) && input.Target.ThreadID == "" && json.Unmarshal(input.Target.Data, data) == nil && c.valid(*data)
}

func passive(target targetData) bool {
	window := 5 * time.Minute
	if target.Type == "c2c" {
		window = time.Hour
	}
	return target.MessageAt != nil && time.Now().Before(time.UnixMilli(*target.MessageAt).Add(window))
}

func route(kind, chatID, operation string) string {
	scope := "groups"
	if kind == "c2c" {
		scope = "users"
	}
	return "/v2/" + scope + "/" + url.PathEscape(chatID) + "/" + operation
}

type nativeSend struct {
	Type      int               `json:"msg_type"`
	Sequence  uint16            `json:"msg_seq"`
	MessageID string            `json:"msg_id,omitempty"`
	Content   string            `json:"content,omitempty"`
	Markdown  *markdown         `json:"markdown,omitempty"`
	Media     *nativeMedia      `json:"media,omitempty"`
	Reference *messageReference `json:"message_reference,omitempty"`
}

type markdown struct {
	Content string `json:"content"`
}
type nativeMedia struct {
	FileInfo string `json:"file_info"`
}
type messageReference struct {
	MessageID string `json:"message_id"`
}

func prepareSend(input model.SendInput, target targetData, content, file string) (nativeSend, error) {
	body := nativeSend{Type: 2, Sequence: 1, Markdown: &markdown{Content: content}}
	if file != "" {
		body.Type = 7
		body.Markdown = nil
		body.Media = &nativeMedia{FileInfo: file}
		body.Content = input.Chunk.Text
	}
	if passive(target) {
		var random [2]byte
		if _, err := rand.Read(random[:]); err != nil {
			return body, err
		}
		body.MessageID = target.MessageID
		body.Sequence = binary.BigEndian.Uint16(random[:])
	}
	if input.Reply != nil && target.MessageIndex != "" {
		body.Reference = &messageReference{MessageID: target.MessageIndex}
	}
	return body, nil
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	var target targetData
	if !c.sendTarget(input, &target) {
		return common.Reject("invalid_target"), nil
	}
	if code := common.ValidateRich(input, richLimits, model.UTF8, common.MediaLimit(c.host)); code != "" {
		return common.Reject(code), nil
	}
	file, err := c.upload(ctx, input, target)
	if err != nil {
		return c.failure(err, true), nil
	}
	content, err := c.richMarkdown(ctx, input)
	if err != nil {
		return c.failure(err, true), nil
	}
	// Publication/upload can cross the native passive window; check immediately
	// before transmission and omit expired msg_id even for media replies.
	body, err := prepareSend(input, target, content, file)
	if err != nil {
		return c.failure(err, true), nil
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	var response struct {
		ID string `json:"id"`
	}
	if err = c.api(ctx, "POST", route(target.Type, input.Target.ChatID, "messages"), body, &response); err != nil {
		return c.failure(err, false), nil
	}
	if response.ID == "" {
		return model.SendResult{Status: model.Unknown, ErrorCode: "missing_message_receipt"}, nil
	}
	return common.Sent(response.ID), nil
}
