// Package whatsapp implements Meta's native WhatsApp Cloud API.
package whatsapp

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

const apiBase = "https://graph.facebook.com"
const apiVersion = "v25.0"

type Config struct {
	PhoneNumberID     string          `json:"phoneNumberId"`
	BusinessAccountID string          `json:"businessAccountId"`
	AppSecret         model.SecretRef `json:"appSecret"`
	VerifyToken       model.SecretRef `json:"verifyToken"`
	AccessToken       model.SecretRef `json:"accessToken"`
}

func platformID(value string) bool {
	return value != "" && len(value) <= 1024 && !strings.ContainsAny(value, "\r\n\x00")
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	if !platformID(cfg.PhoneNumberID) || !platformID(cfg.BusinessAccountID) {
		return cfg, errors.New("invalid_business_identity")
	}
	for name, ref := range map[string]model.SecretRef{"appSecret": cfg.AppSecret, "verifyToken": cfg.VerifyToken, "accessToken": cfg.AccessToken} {
		if err := config.ValidateSecretRef(ref, name); err != nil {
			return cfg, err
		}
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
	if account.Channel != model.WhatsApp || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	c := &Channel{host: host, account: account, config: cfg, options: options, client: common.HTTPClient(options.HTTPClient)}
	if err = host.MountHTTP(model.HTTPRoute{Pattern: "/webhook", Handler: http.HandlerFunc(c.webhook), MaxBodyBytes: 2 * 1024 * 1024}); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.WhatsApp }

func (c *Channel) Capabilities() model.ChannelCapabilities {
	return model.ChannelCapabilities{Transport: model.HTTPTransport, MaxTextLength: 4096, LengthUnit: model.UTF16, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitByRendered(value, 4096, model.UTF16, markdown)
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

func markdown(value string) string {
	var out strings.Builder
	for _, run := range text.Runs(value) {
		s := run.Text
		if run.Pre || run.Code {
			if !strings.Contains(s, "```") {
				s = "```" + s + "```"
			}
		} else {
			s = formatRun(s, run)
		}
		out.WriteString(s)
	}
	return out.String()
}

func formatRun(value string, run text.Run) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return value
	}
	start := strings.Index(value, trimmed)
	end := start + len(trimmed)
	if run.Strike {
		trimmed = "~" + trimmed + "~"
	}
	if run.Italic {
		trimmed = "_" + trimmed + "_"
	}
	if run.Bold {
		trimmed = "*" + trimmed + "*"
	}
	if run.Href != "" && run.Href != strings.TrimSpace(value) {
		trimmed += " (" + run.Href + ")"
	}
	return value[:start] + trimmed + value[end:]
}

type targetData struct {
	PhoneNumberID     string `json:"phoneNumberId"`
	BusinessAccountID string `json:"businessAccountId"`
	APIBase           string `json:"apiBase"`
	Customer          string `json:"customer"`
}

func (c *Channel) target(customer string) targetData {
	return targetData{PhoneNumberID: c.config.PhoneNumberID, BusinessAccountID: c.config.BusinessAccountID, APIBase: apiBase, Customer: customer}
}

func (c *Channel) windowKey(customer string) string {
	return "window:" + string(common.Data([]string{apiBase, c.config.BusinessAccountID, c.config.PhoneNumberID, customer}))
}

func (c *Channel) window(ctx context.Context, customer string) (int64, error) {
	value, _, err := common.ReadState[int64](ctx, c.host.State(), c.windowKey(customer))
	return value, err
}

func (c *Channel) updateWindow(ctx context.Context, customer string, until int64) error {
	for attempt := 0; attempt < 8; attempt++ {
		prior, entry, err := common.ReadState[int64](ctx, c.host.State(), c.windowKey(customer))
		if err != nil {
			return err
		}
		if prior >= until {
			return nil
		}
		var expected *int64
		if entry != nil {
			expected = &entry.Version
		}
		result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: c.windowKey(customer), ExpectedVersion: expected, Value: common.Data(until)})
		if err != nil {
			return err
		}
		if result.Status == model.Updated {
			return nil
		}
	}
	return errors.New("customer_window_conflict")
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.WhatsApp || address.AccountID != c.account.ID || !platformID(address.ChatID) || address.ThreadID != "" {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	until, err := c.window(ctx, address.ChatID)
	if err != nil {
		return model.ChannelResolution{}, err
	}
	if time.Now().UnixMilli() >= until {
		return model.ChannelResolution{Reason: "customer_window_expired"}, nil
	}
	target := model.ReplyTarget{Channel: model.WhatsApp, AccountID: c.account.ID, ChatID: address.ChatID, Data: common.Data(c.target(address.ChatID))}
	if learned != nil && c.validTarget(*learned) {
		target.ReplyToID = learned.ReplyToID
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

func (c *Channel) validTarget(target model.ReplyTarget) bool {
	var data targetData
	return target.Channel == model.WhatsApp && target.AccountID == c.account.ID && target.ThreadID == "" && platformID(target.ChatID) && json.Unmarshal(target.Data, &data) == nil && data == c.target(target.ChatID)
}

type media struct {
	ID       string `json:"id"`
	MIME     string `json:"mime_type,omitempty"`
	Caption  string `json:"caption,omitempty"`
	Filename string `json:"filename,omitempty"`
}

type message struct {
	ID        string `json:"id"`
	From      string `json:"from"`
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Text      *struct {
		Body string `json:"body"`
	} `json:"text,omitempty"`
	Image    *media `json:"image,omitempty"`
	Audio    *media `json:"audio,omitempty"`
	Video    *media `json:"video,omitempty"`
	Document *media `json:"document,omitempty"`
}

type webhookBody struct {
	Object  string `json:"object"`
	Entries []struct {
		ID      string `json:"id"`
		Changes []struct {
			Field string `json:"field"`
			Value struct {
				Metadata struct {
					PhoneNumberID string `json:"phone_number_id"`
				} `json:"metadata"`
				Messages []message `json:"messages,omitempty"`
			} `json:"value"`
		} `json:"changes"`
	} `json:"entry"`
}

func (c *Channel) webhook(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		c.verify(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	secret, err := c.options.Secret(c.config.AppSecret)
	if err != nil || secret == "" {
		w.WriteHeader(503)
		return
	}
	raw, err := common.ReadBounded(r.Body, 2*1024*1024)
	if err != nil {
		w.WriteHeader(413)
		return
	}
	signature, err := hex.DecodeString(strings.TrimPrefix(r.Header.Get("X-Hub-Signature-256"), "sha256="))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(raw)
	if err != nil || !strings.HasPrefix(r.Header.Get("X-Hub-Signature-256"), "sha256=") || !hmac.Equal(signature, mac.Sum(nil)) {
		w.WriteHeader(401)
		return
	}
	var body webhookBody
	if json.Unmarshal(raw, &body) != nil || body.Object != "whatsapp_business_account" {
		w.WriteHeader(400)
		return
	}
	if err = c.receiveBody(r.Context(), body); err != nil {
		w.WriteHeader(503)
		return
	}
	w.WriteHeader(200)
}

func (c *Channel) verify(w http.ResponseWriter, r *http.Request) {
	token, err := c.options.Secret(c.config.VerifyToken)
	query := r.URL.Query()
	if err != nil || token == "" || query.Get("hub.mode") != "subscribe" || !hmac.Equal([]byte(token), []byte(query.Get("hub.verify_token"))) {
		w.WriteHeader(403)
		return
	}
	if query.Get("hub.challenge") == "" {
		w.WriteHeader(400)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte(query.Get("hub.challenge")))
}

func (c *Channel) receiveBody(ctx context.Context, body webhookBody) error {
	for _, entry := range body.Entries {
		if entry.ID != c.config.BusinessAccountID {
			continue
		}
		for _, change := range entry.Changes {
			if change.Field != "messages" || change.Value.Metadata.PhoneNumberID != c.config.PhoneNumberID {
				continue
			}
			for _, m := range change.Value.Messages {
				if err := c.receive(ctx, m); err != nil && !common.PolicyRejection(err) {
					return err
				}
			}
		}
	}
	return nil
}

func (c *Channel) receive(ctx context.Context, m message) error {
	if !common.Contains(c.account.AllowedSenders, m.From) {
		return nil
	}
	if !platformID(m.ID) || !platformID(m.From) {
		return errors.New("invalid_native_message")
	}
	seconds, err := strconv.ParseInt(m.Timestamp, 10, 64)
	if err != nil || seconds < 0 || seconds > time.Now().Add(5*time.Minute).Unix() {
		return errors.New("invalid_native_timestamp")
	}
	if err = c.updateWindow(ctx, m.From, time.Unix(seconds, 0).Add(24*time.Hour).UnixMilli()); err != nil {
		return err
	}
	value, attachments, err := c.receiveMedia(ctx, m)
	if err != nil {
		return err
	}
	if value == "" && len(attachments) == 0 {
		return nil
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.WhatsApp, AccountID: c.account.ID, EventID: m.ID}, SenderID: m.From, Text: value, Attachments: attachments, ReceivedAt: time.Now(), Target: model.ReplyTarget{Channel: model.WhatsApp, AccountID: c.account.ID, ChatID: m.From, ReplyToID: m.ID, Data: common.Data(c.target(m.From))}})
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

func endpoint(id, suffix string) string {
	return apiBase + "/" + apiVersion + "/" + url.PathEscape(id) + suffix
}
