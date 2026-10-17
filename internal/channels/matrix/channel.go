// Package matrix connects native Matrix accounts using the maintained mautrix SDK.
package matrix

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/relanox/relanox/internal/transport"
	"github.com/rs/zerolog"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/id"
)

type Config struct {
	Homeserver             string          `json:"homeserver"`
	AccessToken            model.SecretRef `json:"accessToken"`
	AllowInsecureLocalhost bool            `json:"allowInsecureLocalhost,omitempty"`
}

func platformID(value string) bool {
	return value != "" && len(value) <= 1024 && !strings.ContainsAny(value, "\x00\r\n")
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	if err := config.ValidateSecretRef(cfg.AccessToken, "accessToken"); err != nil {
		return cfg, err
	}
	cfg.Homeserver = strings.TrimRight(cfg.Homeserver, "/")
	u, err := url.Parse(cfg.Homeserver)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return cfg, errors.New("invalid_homeserver")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local && cfg.AllowInsecureLocalhost) {
		return cfg, errors.New("insecure_homeserver")
	}
	return cfg, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type identity struct {
	Credential [32]byte
	UserID     id.UserID
	DeviceID   id.DeviceID
}

type Channel struct {
	host         model.ChannelHost
	account      model.AccountConfig
	config       Config
	options      common.Options
	http         *http.Client
	rooms        []string
	lifecycle    common.Lifecycle
	identityGate chan struct{}
	identity     atomic.Pointer[identity]
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.Matrix || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	client := options.HTTPClient
	if client == nil {
		u, _ := url.Parse(cfg.Homeserver)
		client = transport.NewClient(transport.Options{Timeout: 90 * time.Second, AllowPrivateHosts: []string{u.Hostname()}, TLSClientConfig: options.TLSClientConfig})
	}
	return &Channel{host: host, account: account, config: cfg, options: options, http: common.HTTPClient(client), rooms: host.BoundChatIDs(), identityGate: make(chan struct{}, 1)}, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.Matrix }

var richLimits = model.RichTextLimits{MaxParts: 20, MaxTextLength: 8000}

func (c *Channel) Capabilities() model.ChannelCapabilities {
	limits := richLimits
	limits.MaxImageBytes = common.MediaLimit(c.host)
	identity := c.identity.Load()
	return model.ChannelCapabilities{Transport: model.ConnectionTransport, MaxTextLength: 16000, LengthUnit: model.UTF8, IdempotentSend: identity != nil && identity.DeviceID != "", RichText: &limits, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitByRendered(value, 16000, model.UTF8, func(s string) string { return text.Plain(s) + text.Matrix(s) })
}

func (c *Channel) Start(ctx context.Context) error { return c.lifecycle.Start(ctx, c.loop) }

func (c *Channel) Close(ctx context.Context) error {
	c.http.CloseIdleConnections()
	return c.lifecycle.Close(ctx)
}

// Disable SDK request logging even when a caller carries a zerolog context.
func quiet(ctx context.Context) context.Context { return zerolog.Nop().WithContext(ctx) }

func (c *Channel) client(ctx context.Context) (*mautrix.Client, error) {
	token, err := c.options.Secret(c.config.AccessToken)
	if err != nil {
		return nil, err
	}
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("invalid_access_token")
	}
	client, err := mautrix.NewClient(c.config.Homeserver, "", token)
	if err != nil {
		return nil, errors.New("invalid_homeserver")
	}
	client.Client = c.http
	client.DefaultHTTPRetries = 0
	client.IgnoreRateLimit = true
	client.ResponseSizeLimit = common.MaxJSONBytes
	client.Log = zerolog.Nop()
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
	if known == nil || known.Credential != credential {
		response, err := client.Whoami(quiet(ctx))
		if err != nil {
			return nil, err
		}
		if response == nil || !platformID(string(response.UserID)) {
			return nil, errors.New("invalid_matrix_identity")
		}
		known = &identity{Credential: credential, UserID: response.UserID, DeviceID: response.DeviceID}
		c.identity.Store(known)
	}
	client.UserID = known.UserID
	client.DeviceID = known.DeviceID
	return client, nil
}

type targetData struct {
	Homeserver string `json:"homeserver"`
	UserID     string `json:"userId"`
	DeviceID   string `json:"deviceId,omitempty"`
}

func (c *Channel) target(client *mautrix.Client) targetData {
	return targetData{Homeserver: c.config.Homeserver, UserID: string(client.UserID), DeviceID: string(client.DeviceID)}
}

func (c *Channel) validTarget(target model.ReplyTarget, client *mautrix.Client) bool {
	var data targetData
	return target.Channel == model.Matrix && target.AccountID == c.account.ID && platformID(target.ChatID) && (target.ThreadID == "" || platformID(target.ThreadID)) && json.Unmarshal(target.Data, &data) == nil && data == c.target(client)
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.Matrix || address.AccountID != c.account.ID || !platformID(address.ChatID) || address.ThreadID != "" && !platformID(address.ThreadID) {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	client, err := c.client(ctx)
	if err != nil {
		return model.ChannelResolution{}, err
	}
	target := model.ReplyTarget{Channel: model.Matrix, AccountID: c.account.ID, ChatID: address.ChatID, ThreadID: address.ThreadID, Data: common.Data(c.target(client))}
	if learned != nil {
		if !c.validTarget(*learned, client) || learned.ChatID != address.ChatID || learned.ThreadID != address.ThreadID {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		target = *learned
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}
