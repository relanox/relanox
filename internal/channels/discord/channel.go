// Package discord connects native bot accounts using Discord's Gateway and REST.
package discord

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/bwmarrin/discordgo"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/relanox/relanox/internal/transport"
)

type Config struct {
	BotToken   model.SecretRef `json:"botToken"`
	APIBaseURL string          `json:"apiBaseUrl,omitempty"`
	// Changing this nonempty administrator-selected epoch explicitly abandons
	// unavailable inbound history once. Already committed Core work is untouched.
	RecoveryEpoch string `json:"recoveryEpoch,omitempty"`
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	if err := config.ValidateSecretRef(cfg.BotToken, "botToken"); err != nil {
		return cfg, err
	}
	if len(cfg.RecoveryEpoch) > 128 || strings.IndexFunc(cfg.RecoveryEpoch, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return cfg, errors.New("invalid_recovery_epoch")
	}
	if cfg.APIBaseURL == "" {
		cfg.APIBaseURL = "https://discord.com/api/v10"
	}
	cfg.APIBaseURL = strings.TrimRight(cfg.APIBaseURL, "/")
	u, err := url.Parse(cfg.APIBaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return cfg, errors.New("invalid_api_base_url")
	}
	return cfg, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

func snowflake(value string) bool {
	n, err := strconv.ParseUint(value, 10, 64)
	return err == nil && n != 0 && len(value) <= 20
}

type identity struct {
	Credential [32]byte
	UserID     string
}

type Channel struct {
	host         model.ChannelHost
	account      model.AccountConfig
	config       Config
	options      common.Options
	http         *http.Client
	lifecycle    common.Lifecycle
	identity     atomic.Pointer[identity]
	identityGate chan struct{}
	addresses    []model.ChannelAddress
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.Discord || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	client := options.HTTPClient
	if client == nil {
		u, _ := url.Parse(cfg.APIBaseURL)
		client = transport.NewClient(transport.Options{Timeout: 45 * time.Second, AllowPrivateHosts: []string{u.Hostname()}, TLSClientConfig: options.TLSClientConfig})
	}
	return &Channel{host: host, account: account, config: cfg, options: options, http: common.HTTPClient(client), identityGate: make(chan struct{}, 1), addresses: host.BoundAddresses()}, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.Discord }

var richLimits = model.RichTextLimits{MaxParts: 10, MaxTextLength: 1800, MaxTotalImageBytes: 20 << 20}

func (c *Channel) Capabilities() model.ChannelCapabilities {
	limits := richLimits
	limits.MaxImageBytes = min(common.MediaLimit(c.host), 10<<20)
	return model.ChannelCapabilities{Transport: model.ConnectionTransport, MaxTextLength: 2000, LengthUnit: model.UTF16, RichText: &limits, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitMarkdown(value, 2000, model.UTF16)
}

func (c *Channel) Start(ctx context.Context) error { return c.lifecycle.Start(ctx, c.loop) }

func (c *Channel) Close(ctx context.Context) error {
	c.http.CloseIdleConnections()
	return c.lifecycle.Close(ctx)
}

func (c *Channel) token() (string, error) {
	value, err := c.options.Secret(c.config.BotToken)
	if err != nil {
		return "", err
	}
	if value == "" || strings.ContainsAny(value, "\r\n") {
		return "", errors.New("invalid_bot_token")
	}
	return value, nil
}

func (c *Channel) api(ctx context.Context, method, path string, input, output any) error {
	var body []byte
	if input != nil {
		var err error
		body, err = json.Marshal(input)
		if err != nil {
			return err
		}
	}
	return c.nativeRequest(ctx, method, c.config.APIBaseURL+path, "application/json", body, output)
}

func (c *Channel) identify(ctx context.Context) (*identity, error) {
	token, err := c.token()
	if err != nil {
		return nil, err
	}
	credential := sha256.Sum256([]byte(token))
	select {
	case c.identityGate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.identityGate }()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	known := c.identity.Load()
	if known != nil && known.Credential == credential {
		return known, nil
	}
	var user discordgo.User
	if err = c.api(ctx, http.MethodGet, "/users/@me", nil, &user); err != nil {
		return nil, err
	}
	if !snowflake(user.ID) || !user.Bot {
		return nil, errors.New("invalid_discord_bot_identity")
	}
	known = &identity{Credential: credential, UserID: user.ID}
	c.identity.Store(known)
	return known, nil
}

type targetData struct {
	APIBaseURL string `json:"apiBaseUrl"`
	BotID      string `json:"botId"`
	GuildID    string `json:"guildId,omitempty"`
}

func (c *Channel) nativeChannel(ctx context.Context, chat, thread string) (*discordgo.Channel, error) {
	nativeID := chat
	if thread != "" {
		nativeID = thread
	}
	var channel discordgo.Channel
	if err := c.api(ctx, http.MethodGet, "/channels/"+nativeID, nil, &channel); err != nil {
		return nil, err
	}
	if channel.ID != nativeID {
		return nil, errors.New("native_channel_identity_changed")
	}
	if thread != "" && (!channel.IsThread() || channel.ParentID != chat) {
		return nil, errors.New("native_thread_identity_changed")
	}
	if thread == "" && channel.IsThread() {
		return nil, errors.New("native_thread_required")
	}
	return &channel, nil
}

func (c *Channel) validTarget(target model.ReplyTarget, bot *identity, channel *discordgo.Channel) bool {
	var data targetData
	return target.Channel == model.Discord && target.AccountID == c.account.ID && snowflake(target.ChatID) && (target.ThreadID == "" || snowflake(target.ThreadID)) && json.Unmarshal(target.Data, &data) == nil && data == (targetData{APIBaseURL: c.config.APIBaseURL, BotID: bot.UserID, GuildID: channel.GuildID})
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.Discord || address.AccountID != c.account.ID || !snowflake(address.ChatID) || address.ThreadID != "" && !snowflake(address.ThreadID) {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	bot, err := c.identify(ctx)
	if err != nil {
		return model.ChannelResolution{}, err
	}
	native, err := c.nativeChannel(ctx, address.ChatID, address.ThreadID)
	if err != nil {
		return model.ChannelResolution{}, err
	}
	target := model.ReplyTarget{Channel: model.Discord, AccountID: c.account.ID, ChatID: address.ChatID, ThreadID: address.ThreadID, Data: common.Data(targetData{APIBaseURL: c.config.APIBaseURL, BotID: bot.UserID, GuildID: native.GuildID})}
	if learned != nil {
		if !c.validTarget(*learned, bot, native) || learned.ChatID != address.ChatID || learned.ThreadID != address.ThreadID {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		target = *learned
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}
