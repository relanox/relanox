package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

type Config struct {
	AppID             string          `json:"appId"`
	AppSecret         model.SecretRef `json:"appSecret"`
	VerificationToken model.SecretRef `json:"verificationToken"`
	EncryptKey        model.SecretRef `json:"encryptKey"`
	TenantKey         string          `json:"tenantKey"`
	Domain            string          `json:"domain,omitempty"`
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var c Config
	if err := common.DecodeConfig(raw, &c); err != nil {
		return c, err
	}
	if c.AppID == "" || len(c.AppID) > 256 || c.TenantKey == "" || len(c.TenantKey) > 256 {
		return c, errors.New("invalid_feishu_identity")
	}
	for name, ref := range map[string]model.SecretRef{"appSecret": c.AppSecret, "verificationToken": c.VerificationToken, "encryptKey": c.EncryptKey} {
		if err := config.ValidateSecretRef(ref, name); err != nil {
			return c, err
		}
	}
	if c.Domain == "" {
		c.Domain = "feishu"
	}
	if c.Domain != "feishu" && c.Domain != "lark" {
		return c, errors.New("invalid_feishu_domain")
	}
	return c, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host         model.ChannelHost
	account      model.AccountConfig
	config       Config
	options      common.Options
	tokens       common.TokenCache
	lifecycle    common.Lifecycle
	mu           sync.Mutex
	botID        string
	identityGate chan struct{}
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.Feishu || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	c := &Channel{host: host, account: account, config: cfg, options: options, identityGate: make(chan struct{}, 1)}
	if err = host.MountHTTP(model.HTTPRoute{Pattern: "/webhook", Handler: http.HandlerFunc(c.webhook), MaxBodyBytes: 1024 * 1024}); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Channel) base() string {
	if c.config.Domain == "lark" {
		return "https://open.larksuite.com"
	}
	return "https://open.feishu.cn"
}

func (c *Channel) Kind() model.ChannelKind { return model.Feishu }

var richLimits = model.RichTextLimits{MaxParts: 20, MaxTextLength: 8000}
var nativeID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func (c *Channel) Capabilities() model.ChannelCapabilities {
	limits := richLimits
	return model.ChannelCapabilities{Transport: model.HTTPTransport, MaxTextLength: 10000, LengthUnit: model.UTF8, RichText: &limits, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitMarkdown(value, 10000, model.UTF8)
}

func (c *Channel) Start(ctx context.Context) error {
	return c.lifecycle.Start(ctx, func(ctx context.Context) {
		for ctx.Err() == nil {
			if _, err := c.ensureIdentity(ctx); err == nil {
				c.host.Connection(model.Connected, "")
				<-ctx.Done()
				return
			}
			c.host.Connection(model.Degraded, "feishu_startup_failed")
			if common.Delay(ctx, time.Second) != nil {
				return
			}
		}
	})
}

func (c *Channel) Close(ctx context.Context) error {
	err := c.lifecycle.Close(ctx)
	c.host.Connection(model.Disconnected, "")
	return err
}

type targetData struct {
	TenantKey    string `json:"tenantKey"`
	AppID        string `json:"appId"`
	BotID        string `json:"botId"`
	APIBaseURL   string `json:"apiBaseUrl"`
	ThreadAnchor string `json:"threadAnchor,omitempty"`
}

func (c *Channel) identity(botID string) targetData {
	return targetData{TenantKey: c.config.TenantKey, AppID: c.config.AppID, BotID: botID, APIBaseURL: c.base()}
}

func (c *Channel) valid(data targetData, botID string) bool {
	return data.TenantKey == c.config.TenantKey && data.AppID == c.config.AppID && data.BotID == botID && data.APIBaseURL == c.base()
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.Feishu || address.AccountID != c.account.ID || !nativeID.MatchString(address.ChatID) || (address.ThreadID != "" && !nativeID.MatchString(address.ThreadID)) {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	botID, err := c.ensureIdentity(ctx)
	if err != nil {
		return model.ChannelResolution{Reason: "oauth_unavailable"}, nil
	}
	var prior targetData
	known := learned != nil && learned.Channel == model.Feishu && learned.AccountID == c.account.ID && learned.ChatID == address.ChatID && learned.ThreadID == address.ThreadID && json.Unmarshal(learned.Data, &prior) == nil && c.valid(prior, botID)
	if learned != nil && !known {
		return model.ChannelResolution{Reason: "target_identity_changed"}, nil
	}
	data := c.identity(botID)
	if address.ThreadID != "" {
		if !known {
			return model.ChannelResolution{Reason: "address_unresolved"}, nil
		}
		data.ThreadAnchor = prior.ThreadAnchor
		if data.ThreadAnchor == "" {
			data.ThreadAnchor = learned.ReplyToID
		}
		if !nativeID.MatchString(data.ThreadAnchor) {
			return model.ChannelResolution{Reason: "address_unresolved"}, nil
		}
	}
	target := model.ReplyTarget{Channel: model.Feishu, AccountID: c.account.ID, ChatID: address.ChatID, ThreadID: address.ThreadID, Data: common.Data(data)}
	if known {
		target.ReplyToID = learned.ReplyToID
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	botID, err := c.ensureIdentity(ctx)
	if err != nil {
		return c.failure(err, true), nil
	}
	var target targetData
	if !c.sendTarget(input.Target, botID, &target) {
		return common.Reject("invalid_target"), nil
	}
	replyID := ""
	if input.Reply != nil {
		replyID = input.Target.ReplyToID
	} else if input.Target.ThreadID != "" {
		replyID = target.ThreadAnchor
		if replyID == "" {
			replyID = input.Target.ReplyToID
		}
	}
	if (input.Reply != nil || input.Target.ThreadID != "") && !nativeID.MatchString(replyID) {
		return common.Reject("address_unresolved"), nil
	}
	if code := common.ValidateRich(input, richLimits, model.UTF8, common.MediaLimit(c.host)); code != "" {
		return common.Reject(code), nil
	}
	if input.Chunk.Media != nil && input.Media == nil {
		return common.Reject("missing_media"), nil
	}
	if input.Chunk.Media != nil && input.Chunk.Text != "" {
		return common.Reject("media_caption_unsupported"), nil
	}
	content, kind, err := c.nativeContent(ctx, input)
	if err != nil {
		return c.failure(err, true), nil
	}
	if ctx.Err() != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	id, err := c.sendMessage(ctx, input, content, kind, replyID)
	if err != nil {
		return c.failure(err, false), nil
	}
	return common.Sent(id), nil
}

func (c *Channel) sendTarget(target model.ReplyTarget, botID string, data *targetData) bool {
	return target.Channel == model.Feishu && target.AccountID == c.account.ID && nativeID.MatchString(target.ChatID) && (target.ReplyToID == "" || nativeID.MatchString(target.ReplyToID)) && json.Unmarshal(target.Data, data) == nil && c.valid(*data, botID)
}
