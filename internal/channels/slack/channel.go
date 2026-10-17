// Package slack connects native Slack Events API or Socket Mode installations.
package slack

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/relanox/relanox/internal/transport"
	slackapi "github.com/slack-go/slack"
)

type Config struct {
	BotToken      model.SecretRef  `json:"botToken"`
	AppID         string           `json:"appId"`
	AppToken      *model.SecretRef `json:"appToken,omitempty"`
	SigningSecret *model.SecretRef `json:"signingSecret,omitempty"`
	APIBaseURL    string           `json:"apiBaseUrl,omitempty"`
}

func nativeID(value string) bool {
	if len(value) < 2 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if r < 'A' || r > 'Z' {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

func nativeTime(value string) (time.Time, error) {
	if len(value) > 32 {
		return time.Time{}, errors.New("invalid_native_timestamp")
	}
	parts := strings.Split(value, ".")
	if len(parts) != 2 || len(parts[1]) == 0 || len(parts[1]) > 9 {
		return time.Time{}, errors.New("invalid_native_timestamp")
	}
	seconds, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || seconds < 0 || seconds > 253402300799 {
		return time.Time{}, errors.New("invalid_native_timestamp")
	}
	for _, r := range parts[1] {
		if r < '0' || r > '9' {
			return time.Time{}, errors.New("invalid_native_timestamp")
		}
	}
	nanoseconds, err := strconv.ParseInt(parts[1]+strings.Repeat("0", 9-len(parts[1])), 10, 64)
	if err != nil {
		return time.Time{}, errors.New("invalid_native_timestamp")
	}
	return time.Unix(seconds, nanoseconds), nil
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	if err := config.ValidateSecretRef(cfg.BotToken, "botToken"); err != nil {
		return cfg, err
	}
	if !nativeID(cfg.AppID) || (cfg.AppToken == nil) == (cfg.SigningSecret == nil) {
		return cfg, errors.New("invalid_slack_transport")
	}
	for name, ref := range map[string]*model.SecretRef{"appToken": cfg.AppToken, "signingSecret": cfg.SigningSecret} {
		if ref != nil {
			if err := config.ValidateSecretRef(*ref, name); err != nil {
				return cfg, err
			}
		}
	}
	if cfg.APIBaseURL == "" {
		cfg.APIBaseURL = "https://slack.com/api"
	}
	cfg.APIBaseURL = strings.TrimRight(cfg.APIBaseURL, "/")
	u, err := url.Parse(cfg.APIBaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return cfg, errors.New("invalid_api_base_url")
	}
	return cfg, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type identity struct {
	Credential            [32]byte
	TeamID, UserID, BotID string
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
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.Slack || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	client := options.HTTPClient
	if client == nil {
		u, _ := url.Parse(cfg.APIBaseURL)
		client = transport.NewClient(transport.Options{Timeout: 45 * time.Second, AllowPrivateHosts: []string{u.Hostname()}, TLSClientConfig: options.TLSClientConfig})
	}
	c := &Channel{host: host, account: account, config: cfg, options: options, http: common.HTTPClient(client), identityGate: make(chan struct{}, 1)}
	if cfg.SigningSecret != nil {
		if err = c.mountWebhook(); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.Slack }

var richLimits = model.RichTextLimits{MaxParts: 20, MaxTextLength: 2500, ImageMIMETypes: []string{"image/png", "image/jpeg", "image/gif"}}

func (c *Channel) Capabilities() model.ChannelCapabilities {
	limits := richLimits
	limits.MaxImageBytes = common.MediaLimit(c.host)
	kind := model.HTTPTransport
	if c.config.AppToken != nil {
		kind = model.ConnectionTransport
	}
	return model.ChannelCapabilities{Transport: kind, MaxTextLength: 4000, LengthUnit: model.Codepoint, RichText: &limits, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitByRendered(value, 4000, model.Codepoint, text.Slack)
}

func (c *Channel) Start(ctx context.Context) error {
	if c.config.AppToken == nil {
		c.host.Connection(model.Connected, "")
		return nil
	}
	return c.lifecycle.Start(ctx, c.loop)
}

func (c *Channel) Close(ctx context.Context) error {
	c.http.CloseIdleConnections()
	return c.lifecycle.Close(ctx)
}

// slack-go's JSON parser streams an unbounded body. Its HTTP-client option is a
// production boundary for enforcing the same limits as other native channels;
// all API serialization, response types and Slack errors remain SDK-owned.
type boundedClient struct{ client *http.Client }

func (c boundedClient) Do(request *http.Request) (*http.Response, error) {
	response, err := c.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	limit := common.MaxJSONBytes
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		limit = 64 * 1024
	}
	raw, err := common.ReadBounded(response.Body, limit)
	if err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(raw))
	response.ContentLength = int64(len(raw))
	return response, nil
}

func (c *Channel) credentials() (string, string, error) {
	bot, err := c.options.Secret(c.config.BotToken)
	if err != nil {
		return "", "", err
	}
	app := ""
	if c.config.AppToken != nil {
		app, err = c.options.Secret(*c.config.AppToken)
	}
	if err != nil {
		return "", "", err
	}
	if bot == "" || strings.ContainsAny(bot+app, "\r\n") || c.config.AppToken != nil && app == "" {
		return "", "", errors.New("invalid_slack_credentials")
	}
	return bot, app, nil
}

func (c *Channel) client(ctx context.Context) (*slackapi.Client, *identity, error) {
	bot, app, err := c.credentials()
	if err != nil {
		return nil, nil, err
	}
	client := slackapi.New(bot, slackapi.OptionAPIURL(c.config.APIBaseURL+"/"), slackapi.OptionHTTPClient(boundedClient{c.http}), slackapi.OptionAppLevelToken(app), slackapi.OptionLog(log.New(io.Discard, "", 0)))
	credential := sha256.Sum256([]byte(bot + "\x00" + app))
	select {
	case c.identityGate <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	defer func() { <-c.identityGate }()
	if err = ctx.Err(); err != nil {
		return nil, nil, err
	}
	known := c.identity.Load()
	if known != nil && known.Credential == credential {
		return client, known, nil
	}
	response, err := client.AuthTestContext(ctx)
	if err != nil {
		return nil, nil, err
	}
	if response == nil || !nativeID(response.TeamID) || !nativeID(response.UserID) || !nativeID(response.BotID) {
		return nil, nil, errors.New("invalid_slack_bot_identity")
	}
	info, err := client.GetBotInfoContext(ctx, slackapi.GetBotInfoParameters{Bot: response.BotID, TeamID: response.TeamID})
	if err != nil {
		return nil, nil, err
	}
	if info == nil || info.ID != response.BotID || info.AppID != c.config.AppID || info.Deleted || info.UserID != "" && info.UserID != response.UserID {
		return nil, nil, errors.New("slack_app_identity_mismatch")
	}
	known = &identity{Credential: credential, TeamID: response.TeamID, UserID: response.UserID, BotID: response.BotID}
	c.identity.Store(known)
	return client, known, nil
}

type targetData struct {
	APIBaseURL string `json:"apiBaseUrl"`
	AppID      string `json:"appId"`
	TeamID     string `json:"teamId"`
	UserID     string `json:"userId"`
	BotID      string `json:"botId"`
}

func (c *Channel) target(bot *identity) targetData {
	return targetData{APIBaseURL: c.config.APIBaseURL, AppID: c.config.AppID, TeamID: bot.TeamID, UserID: bot.UserID, BotID: bot.BotID}
}

func (c *Channel) validTarget(target model.ReplyTarget, bot *identity) bool {
	var data targetData
	return target.Channel == model.Slack && target.AccountID == c.account.ID && nativeID(target.ChatID) && json.Unmarshal(target.Data, &data) == nil && data == c.target(bot)
}

func validAddress(chat, thread string) bool {
	if !nativeID(chat) {
		return false
	}
	if thread != "" {
		_, err := nativeTime(thread)
		return err == nil
	}
	return true
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.Slack || address.AccountID != c.account.ID || !validAddress(address.ChatID, address.ThreadID) {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	_, bot, err := c.client(ctx)
	if err != nil {
		return model.ChannelResolution{}, err
	}
	target := model.ReplyTarget{Channel: model.Slack, AccountID: c.account.ID, ChatID: address.ChatID, ThreadID: address.ThreadID, Data: common.Data(c.target(bot))}
	if learned != nil {
		if !c.validTarget(*learned, bot) || learned.ChatID != address.ChatID || learned.ThreadID != address.ThreadID {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		target = *learned
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}
