// Package mattermost implements the native Mattermost v4 REST and WebSocket APIs.
package mattermost

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	mm "github.com/mattermost/mattermost/server/public/model"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/relanox/relanox/internal/transport"
)

type Config struct {
	ServerURL              string          `json:"serverUrl"`
	Token                  model.SecretRef `json:"token"`
	AllowInsecureLocalhost bool            `json:"allowInsecureLocalhost,omitempty"`
	RecoveryEpoch          string          `json:"recoveryEpoch,omitempty"`
}

var epochSyntax = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	if err := config.ValidateSecretRef(cfg.Token, "token"); err != nil {
		return cfg, err
	}
	if cfg.RecoveryEpoch != "" && !epochSyntax.MatchString(cfg.RecoveryEpoch) {
		return cfg, errors.New("invalid_recovery_epoch")
	}
	u, err := url.Parse(cfg.ServerURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(u.Path, "\\") || strings.Contains(u.Path, "..") {
		return cfg, errors.New("invalid_server_url")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local && cfg.AllowInsecureLocalhost) {
		return cfg, errors.New("insecure_server_url")
	}
	cfg.ServerURL = strings.TrimRight(u.String(), "/")
	return cfg, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host       model.ChannelHost
	account    model.AccountConfig
	config     Config
	options    common.Options
	client     *http.Client
	identities common.TokenCache
	lifecycle  common.Lifecycle
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if host == nil || account.Channel != model.Mattermost || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	client := options.HTTPClient
	if client == nil {
		u, _ := url.Parse(cfg.ServerURL)
		client = transport.NewClient(transport.Options{Timeout: 120 * time.Second, AllowedHosts: []string{u.Hostname()}, AllowPrivateHosts: []string{u.Hostname()}, TLSClientConfig: options.TLSClientConfig})
	}
	return &Channel{host: host, account: account, config: cfg, options: options, client: common.HTTPClient(client)}, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.Mattermost }

func (c *Channel) Capabilities() model.ChannelCapabilities {
	result := model.ChannelCapabilities{Transport: model.ConnectionTransport, MaxTextLength: 16000, LengthUnit: model.Codepoint, MaxAttachments: 10, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
	if c.host.PublicURL() != "" && c.host.Media() != nil {
		result.RichText = &model.RichTextLimits{MaxParts: 20, MaxTextLength: 8000, MaxImageBytes: common.MediaLimit(c.host)}
	}
	return result
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitMarkdown(value, 16000, model.Codepoint)
}

func (c *Channel) Start(ctx context.Context) error { return c.lifecycle.Start(ctx, c.run) }

func (c *Channel) Close(ctx context.Context) error {
	err := c.lifecycle.Close(ctx)
	c.client.CloseIdleConnections()
	return err
}

type targetData struct {
	ServerURL string `json:"serverUrl"`
	BotUserID string `json:"botUserId"`
}

func (c *Channel) credentials(ctx context.Context) (targetData, string, error) {
	token, err := c.options.Secret(c.config.Token)
	if err != nil || token == "" || strings.ContainsAny(token, "\r\n") {
		return targetData{}, "", errors.New("oauth_unavailable")
	}
	user, err := c.identities.Get(ctx, token, func(ctx context.Context) (string, time.Time, error) {
		var identity mm.User
		err := common.JSON(ctx, c.client, http.MethodGet, c.config.ServerURL+"/api/v4/users/me", bearer(token), nil, &identity)
		if err != nil || !mm.IsValidId(identity.Id) {
			return "", time.Time{}, errors.New("native_identity_unavailable")
		}
		return identity.Id, time.Now().Add(time.Minute), nil
	})
	return targetData{ServerURL: c.config.ServerURL, BotUserID: user}, token, err
}

func bearer(token string) http.Header {
	return http.Header{"Authorization": []string{"Bearer " + token}}
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.Mattermost || address.AccountID != c.account.ID || !mm.IsValidId(address.ChatID) || (address.ThreadID != "" && !mm.IsValidId(address.ThreadID)) {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	identity, _, err := c.credentials(ctx)
	if err != nil {
		return model.ChannelResolution{}, err
	}
	target := model.ReplyTarget{Channel: model.Mattermost, AccountID: c.account.ID, ChatID: address.ChatID, ThreadID: address.ThreadID, Data: common.Data(identity)}
	if learned != nil {
		var previous targetData
		if learned.Channel != target.Channel || learned.AccountID != target.AccountID || learned.ChatID != target.ChatID || learned.ThreadID != target.ThreadID || common.DecodeConfig(learned.Data, &previous) != nil || previous != identity {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		if mm.IsValidId(learned.ReplyToID) {
			target.ReplyToID = learned.ReplyToID
		}
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}
