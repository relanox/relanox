// Package googlechat implements native Google Chat interaction events and REST messages.
package googlechat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/relanox/relanox/internal/transport"
	chat "google.golang.org/api/chat/v1"
	"google.golang.org/api/idtoken"
	"google.golang.org/api/option"
)

const apiOrigin = "https://chat.googleapis.com/"

type Config struct {
	ServiceAccount model.SecretRef `json:"serviceAccount"`
}

func ValidateConfig(raw json.RawMessage) error {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return err
	}
	return config.ValidateSecretRef(cfg.ServiceAccount, "serviceAccount")
}

var spaceID = regexp.MustCompile(`^spaces/[A-Za-z0-9_-]{1,256}$`)
var userID = regexp.MustCompile(`^users/[A-Za-z0-9_-]{1,256}$`)
var messageID = regexp.MustCompile(`^spaces/[A-Za-z0-9_-]{1,256}/messages/[A-Za-z0-9_.-]{1,512}$`)
var threadID = regexp.MustCompile(`^spaces/[A-Za-z0-9_-]{1,256}/threads/[A-Za-z0-9_.-]{1,512}$`)

type Channel struct {
	host      model.ChannelHost
	account   model.AccountConfig
	config    Config
	options   common.Options
	client    *http.Client
	service   *chat.Service
	validator *idtoken.Validator
	audience  string
	tokens    common.TokenCache
	lifecycle common.Lifecycle
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	if err := ValidateConfig(account.Config); err != nil {
		return nil, err
	}
	if host == nil || host.PublicURL() == "" {
		return nil, errors.New("public_url_required")
	}
	if account.Channel != model.GoogleChat || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	var cfg Config
	_ = json.Unmarshal(account.Config, &cfg)
	client := options.HTTPClient
	if client == nil {
		client = transport.NewClient(transport.Options{Timeout: 120 * time.Second, AllowedHosts: []string{"chat.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"}, TLSClientConfig: options.TLSClientConfig})
	}
	client = common.HTTPClient(client)
	bounded := *client
	bounded.Transport = boundedTransport{base: client.Transport}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := chat.NewService(context.Background(), option.WithHTTPClient(&bounded), option.WithLogger(logger))
	if err != nil {
		return nil, errors.New("googlechat_client_unavailable")
	}
	validator, err := idtoken.NewValidator(context.Background(), option.WithHTTPClient(&bounded), option.WithLogger(logger))
	if err != nil {
		return nil, errors.New("googlechat_verifier_unavailable")
	}
	c := &Channel{host: host, account: account, config: cfg, options: options, client: &bounded, service: service, validator: validator, audience: strings.TrimRight(host.PublicURL(), "/") + "/channels/googlechat/" + account.ID + "/webhook"}
	err = host.MountHTTP(model.HTTPRoute{Pattern: "/webhook", Handler: http.HandlerFunc(c.webhook), Authorize: c.authorize, MaxBodyBytes: 2 << 20})
	return c, err
}

func (c *Channel) Kind() model.ChannelKind { return model.GoogleChat }

func (c *Channel) Capabilities() model.ChannelCapabilities {
	return model.ChannelCapabilities{Transport: model.HTTPTransport, MaxTextLength: 30000, LengthUnit: model.UTF8, IdempotentSend: true, MaxAttachments: 10, RichText: &model.RichTextLimits{MaxParts: 20, MaxTextLength: 2000}, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitByRendered(value, 30000, model.UTF8, func(fragment string) string {
		return string(common.Data(&chat.Message{Text: fragment, MarkupSyntax: "MARKUP_SYNTAX_MARKDOWN"}))
	})
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

type scope struct {
	ClientEmail string `json:"clientEmail"`
	APIBase     string `json:"apiBase"`
}

type targetData struct {
	Space  string                      `json:"space"`
	Thread string                      `json:"thread,omitempty"`
	Scope  scope                       `json:"scope"`
	Quote  *chat.QuotedMessageMetadata `json:"quotedMessageMetadata,omitempty"`
}

func validAddress(space, thread string) bool {
	return spaceID.MatchString(space) && (thread == "" || (threadID.MatchString(thread) && strings.HasPrefix(thread, space+"/threads/")))
}

func validQuote(quote *chat.QuotedMessageMetadata, space string) bool {
	if quote == nil || !messageID.MatchString(quote.Name) || !strings.HasPrefix(quote.Name, space+"/messages/") {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, quote.LastUpdateTime)
	return err == nil
}

func (c *Channel) Resolve(_ context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.GoogleChat || address.AccountID != c.account.ID || !validAddress(address.ChatID, address.ThreadID) {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	credentials, _, err := c.credentials()
	if err != nil {
		return model.ChannelResolution{}, err
	}
	data := targetData{Space: address.ChatID, Thread: address.ThreadID, Scope: scope{ClientEmail: credentials.Email, APIBase: apiOrigin}}
	target := model.ReplyTarget{Channel: model.GoogleChat, AccountID: c.account.ID, ChatID: address.ChatID, ThreadID: address.ThreadID}
	if learned != nil {
		var previous targetData
		if learned.Channel != target.Channel || learned.AccountID != target.AccountID || learned.ChatID != target.ChatID || learned.ThreadID != target.ThreadID || json.Unmarshal(learned.Data, &previous) != nil || previous.Scope != data.Scope {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		if validQuote(previous.Quote, address.ChatID) && previous.Quote.Name == learned.ReplyToID {
			data.Quote = previous.Quote
			target.ReplyToID = learned.ReplyToID
		}
	}
	target.Data = common.Data(data)
	return model.ChannelResolution{Available: true, Target: &target}, nil
}
