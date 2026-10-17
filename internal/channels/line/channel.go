// Package line implements LINE's signed Messaging API webhooks and push messages.
package line

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

const apiBase = "https://api.line.me"
const contentBase = "https://api-data.line.me"

type Config struct {
	ChannelSecret model.SecretRef `json:"channelSecret"`
	AccessToken   model.SecretRef `json:"accessToken"`
}

func platformID(value string) bool {
	return value != "" && len(value) <= 1024 && !strings.ContainsAny(value, "\r\n\x00")
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	for field, ref := range map[string]model.SecretRef{"channelSecret": cfg.ChannelSecret, "accessToken": cfg.AccessToken} {
		if err := config.ValidateSecretRef(ref, field); err != nil {
			return cfg, err
		}
	}
	return cfg, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host       model.ChannelHost
	account    model.AccountConfig
	config     Config
	options    common.Options
	client     *http.Client
	lifecycle  common.Lifecycle
	identityMu sync.Mutex
	credential [32]byte
	botID      string
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.LINE || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	c := &Channel{host: host, account: account, config: cfg, options: options, client: common.HTTPClient(options.HTTPClient)}
	if err = host.MountHTTP(model.HTTPRoute{Pattern: "/webhook", Handler: http.HandlerFunc(c.webhook), MaxBodyBytes: 2 * 1024 * 1024}); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.LINE }

var richLimits = model.RichTextLimits{MaxParts: 20, MaxTextLength: 2000, ImageMIMETypes: []string{"image/jpeg", "image/png"}, MaxImageBytes: 10 * 1024 * 1024}

func (c *Channel) Capabilities() model.ChannelCapabilities {
	capabilities := model.ChannelCapabilities{Transport: model.HTTPTransport, MaxTextLength: 5000, LengthUnit: model.UTF16, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: []model.MediaKind{model.Image, model.Audio, model.Video}}}
	if strings.HasPrefix(c.host.PublicURL(), "https://") && c.host.Media() != nil {
		limits := richLimits
		capabilities.RichText = &limits
	}
	return capabilities
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitByRendered(value, 5000, model.UTF16, func(s string) string {
		size := max(text.Length(quotedPlain(s), model.UTF16), (len(common.Data(flex(s)))+5)/6)
		return strings.Repeat("x", size)
	})
}

func (c *Channel) Start(ctx context.Context) error {
	return c.lifecycle.Start(ctx, func(ctx context.Context) {
		for ctx.Err() == nil {
			if _, err := c.identity(ctx); err == nil {
				c.host.Connection(model.Connected, "")
				<-ctx.Done()
				break
			}
			c.host.Connection(model.Degraded, "identity_unavailable")
			if common.Delay(ctx, time.Second) != nil {
				break
			}
		}
		c.host.Connection(model.Disconnected, "")
	})
}

func (c *Channel) Close(ctx context.Context) error {
	c.client.CloseIdleConnections()
	return c.lifecycle.Close(ctx)
}

func (c *Channel) headers() (http.Header, error) {
	value, err := c.options.Secret(c.config.AccessToken)
	if err != nil {
		return nil, err
	}
	if value == "" {
		return nil, errors.New("missing_credential")
	}
	return http.Header{"Authorization": []string{"Bearer " + value}}, nil
}

func (c *Channel) identity(ctx context.Context) (string, error) {
	headers, err := c.headers()
	if err != nil {
		return "", err
	}
	return c.identityFor(ctx, headers)
}

func (c *Channel) identityFor(ctx context.Context, headers http.Header) (string, error) {
	credential := sha256.Sum256([]byte(headers.Get("Authorization")))
	c.identityMu.Lock()
	defer c.identityMu.Unlock()
	if c.botID != "" && c.credential == credential {
		return c.botID, nil
	}
	var identity struct {
		UserID string `json:"userId"`
	}
	if err := common.JSON(ctx, c.client, http.MethodGet, apiBase+"/v2/bot/info", headers, nil, &identity); err != nil {
		return "", err
	}
	if !platformID(identity.UserID) {
		return "", errors.New("invalid_bot_identity")
	}
	c.botID = identity.UserID
	c.credential = credential
	return c.botID, nil
}

type targetData struct {
	Destination string `json:"destination"`
	SourceType  string `json:"sourceType,omitempty"`
	BotID       string `json:"botId"`
	APIBaseURL  string `json:"apiBaseUrl"`
	QuoteToken  string `json:"quoteToken,omitempty"`
}

func (c *Channel) validTarget(target model.ReplyTarget, botID string) (targetData, bool) {
	var data targetData
	valid := target.Channel == model.LINE && target.AccountID == c.account.ID && target.ThreadID == "" && platformID(target.ChatID) && json.Unmarshal(target.Data, &data) == nil && data.Destination == target.ChatID && data.BotID == botID && data.APIBaseURL == apiBase
	return data, valid
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.LINE || address.AccountID != c.account.ID || !platformID(address.ChatID) || address.ThreadID != "" {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	botID, err := c.identity(ctx)
	if err != nil {
		return model.ChannelResolution{}, err
	}
	target := model.ReplyTarget{Channel: model.LINE, AccountID: c.account.ID, ChatID: address.ChatID, Data: common.Data(targetData{Destination: address.ChatID, BotID: botID, APIBaseURL: apiBase})}
	if learned != nil {
		if _, ok := c.validTarget(*learned, botID); !ok || learned.ChatID != address.ChatID {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		target = *learned
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

type nativeMessage struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	QuoteToken string `json:"quoteToken,omitempty"`
	Filename   string `json:"fileName,omitempty"`
	Size       int64  `json:"fileSize,omitempty"`
	Duration   int64  `json:"duration,omitempty"`
	Provider   *struct {
		Type string `json:"type"`
		URL  string `json:"originalContentUrl,omitempty"`
	} `json:"contentProvider,omitempty"`
}

type event struct {
	Type   string `json:"type"`
	ID     string `json:"webhookEventId"`
	Source *struct {
		Type    string `json:"type"`
		UserID  string `json:"userId,omitempty"`
		GroupID string `json:"groupId,omitempty"`
		RoomID  string `json:"roomId,omitempty"`
	} `json:"source,omitempty"`
	Message *nativeMessage `json:"message,omitempty"`
}

func (c *Channel) webhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	secret, err := c.options.Secret(c.config.ChannelSecret)
	if err != nil || secret == "" {
		w.WriteHeader(503)
		return
	}
	raw, err := common.ReadBounded(r.Body, 2*1024*1024)
	if err != nil {
		w.WriteHeader(413)
		return
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(raw)
	signature, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Line-Signature"))
	if err != nil || !hmac.Equal(signature, mac.Sum(nil)) {
		w.WriteHeader(401)
		return
	}
	var body struct {
		Destination string  `json:"destination"`
		Events      []event `json:"events"`
	}
	if json.Unmarshal(raw, &body) != nil || !platformID(body.Destination) {
		w.WriteHeader(400)
		return
	}
	botID, err := c.identity(r.Context())
	if err != nil {
		w.WriteHeader(503)
		return
	}
	if body.Destination != botID {
		w.WriteHeader(403)
		return
	}
	for _, event := range body.Events {
		if err = c.receive(r.Context(), event, botID); err != nil && !common.PolicyRejection(err) {
			w.WriteHeader(503)
			return
		}
	}
	w.WriteHeader(200)
}

func (c *Channel) receive(ctx context.Context, event event, botID string) error {
	if event.Type != "message" || event.Source == nil || event.Message == nil || event.Source.UserID == botID {
		return nil
	}
	source, m := event.Source, event.Message
	if !common.Contains(c.account.AllowedSenders, source.UserID) || !common.Contains([]string{"text", "image", "audio", "video", "file"}, m.Type) {
		return nil
	}
	if !platformID(event.ID) || !platformID(m.ID) {
		return errors.New("invalid_event_identity")
	}
	destination := source.UserID
	switch source.Type {
	case "user":
	case "group":
		destination = source.GroupID
	case "room":
		destination = source.RoomID
	default:
		return errors.New("invalid_source_type")
	}
	if !platformID(destination) {
		return errors.New("invalid_destination")
	}
	attachments, err := c.receiveMedia(ctx, *m)
	if err != nil {
		return err
	}
	if m.Text == "" && len(attachments) == 0 {
		return nil
	}
	target := model.ReplyTarget{Channel: model.LINE, AccountID: c.account.ID, ChatID: destination, ReplyToID: m.ID, Data: common.Data(targetData{Destination: destination, SourceType: source.Type, BotID: botID, APIBaseURL: apiBase, QuoteToken: m.QuoteToken})}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.LINE, AccountID: c.account.ID, EventID: event.ID}, SenderID: source.UserID, Text: m.Text, Attachments: attachments, Target: target, ReceivedAt: time.Now()})
}
