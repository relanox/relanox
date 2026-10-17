package msteams

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

type Config struct {
	AppID                 string          `json:"appId"`
	BotID                 string          `json:"botId"`
	TenantID              string          `json:"tenantId"`
	AppSecret             model.SecretRef `json:"appSecret"`
	TokenURL              string          `json:"tokenUrl,omitempty"`
	MediaOrigins          []string        `json:"mediaOrigins,omitempty"`
	TrustedUploadOrigins  []string        `json:"trustedUploadOrigins,omitempty"`
	TrustedServiceOrigins []string        `json:"trustedServiceOrigins"`
}

func validEndpoint(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Fragment == ""
}

func platformID(value string) bool { return value != "" && len(value) <= 1024 }

func parseConfig(raw json.RawMessage) (Config, error) {
	var c Config
	if err := common.DecodeConfig(raw, &c); err != nil {
		return c, err
	}
	if !platformID(c.AppID) || !platformID(c.BotID) || !platformID(c.TenantID) {
		return c, errors.New("invalid_teams_identity")
	}
	if err := config.ValidateSecretRef(c.AppSecret, "appSecret"); err != nil {
		return c, err
	}
	if c.TokenURL == "" {
		c.TokenURL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token"
	}
	u, err := url.Parse(c.TokenURL)
	if err != nil || !validEndpoint(c.TokenURL) || u.RawQuery != "" {
		return c, errors.New("invalid_token_endpoint")
	}
	segments := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(segments) != 4 || segments[1] != "oauth2" || segments[2] != "v2.0" || segments[3] != "token" {
		return c, errors.New("invalid_token_endpoint")
	}
	if len(c.TrustedServiceOrigins) == 0 {
		return c, errors.New("trusted_service_origins_required")
	}
	for _, group := range [][]string{c.MediaOrigins, c.TrustedUploadOrigins, c.TrustedServiceOrigins} {
		for _, value := range group {
			if !validEndpoint(value) || common.Origin(value) != value {
				return c, errors.New("invalid_trusted_origin")
			}
		}
	}
	return c, nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host      model.ChannelHost
	account   model.AccountConfig
	config    Config
	options   common.Options
	client    *NativeClient
	lifecycle common.Lifecycle
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.MSTeams || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	c := &Channel{host: host, account: account, config: cfg, options: options, client: &NativeClient{AppID: cfg.AppID, TenantID: cfg.TenantID, TokenURL: cfg.TokenURL, Secret: func() string { return options.SecretValue(cfg.AppSecret) }, HTTP: options.HTTPClient}}
	if err = host.MountHTTP(model.HTTPRoute{Pattern: "/activities", Handler: http.HandlerFunc(c.activities), MaxBodyBytes: 1024 * 1024}); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.MSTeams }

var richLimits = model.RichTextLimits{MaxParts: 20, MaxTextLength: 2000, ImageMIMETypes: []string{"image/png", "image/jpeg", "image/gif"}, MaxImageBytes: 1000000}

func (c *Channel) Capabilities() model.ChannelCapabilities {
	capabilities := model.ChannelCapabilities{Transport: model.HTTPTransport, MaxTextLength: 12000, LengthUnit: model.UTF16, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
	if strings.HasPrefix(c.host.PublicURL(), "https://") && c.host.Media() != nil {
		limits := richLimits
		capabilities.RichText = &limits
	}
	return capabilities
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitMarkdown(value, 12000, model.UTF16)
}

func (c *Channel) Start(ctx context.Context) error {
	return c.lifecycle.Start(ctx, func(ctx context.Context) {
		c.host.Connection(model.Connected, "")
		<-ctx.Done()
		c.host.Connection(model.Disconnected, "")
	})
}

func (c *Channel) Close(ctx context.Context) error { c.client.Close(); return c.lifecycle.Close(ctx) }

type targetData struct {
	AppID          string `json:"appId"`
	ServiceURL     string `json:"serviceUrl"`
	ConversationID string `json:"conversationId"`
	TenantID       string `json:"tenantId"`
	BotID          string `json:"botId"`
	UserID         string `json:"userId"`
	ReplyToID      string `json:"replyToId,omitempty"`
	Personal       bool   `json:"personal,omitempty"`
}

func (c *Channel) valid(data targetData, chatID string) bool {
	return data.AppID == c.config.AppID && data.TenantID == c.config.TenantID && data.BotID == c.config.BotID && data.ConversationID == chatID && data.UserID != ""
}

func (c *Channel) serviceURL(value string) bool {
	u, err := url.Parse(value)
	return err == nil && validEndpoint(value) && u.RawQuery == "" && common.Contains(c.config.TrustedServiceOrigins, common.Origin(value))
}

func (c *Channel) conversationKey(chatID string) string {
	return "conversation:" + string(common.Data([]string{c.config.AppID, c.config.TenantID, c.config.BotID, chatID}))
}

func (c *Channel) Resolve(ctx context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	if address.Platform != model.MSTeams || address.AccountID != c.account.ID || !platformID(address.ChatID) || (address.ThreadID != "" && !platformID(address.ThreadID)) {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	var data targetData
	known := learned != nil && learned.Channel == model.MSTeams && learned.AccountID == c.account.ID && learned.ChatID == address.ChatID && learned.ThreadID == address.ThreadID && json.Unmarshal(learned.Data, &data) == nil && c.valid(data, address.ChatID)
	if learned != nil && !known {
		return model.ChannelResolution{Reason: "target_identity_changed"}, nil
	}
	if !known {
		saved, entry, err := common.ReadState[targetData](ctx, c.host.State(), c.conversationKey(address.ChatID))
		if err != nil {
			return model.ChannelResolution{}, err
		}
		if entry == nil {
			return model.ChannelResolution{Reason: "address_unresolved"}, nil
		}
		data = saved
	}
	if !c.valid(data, address.ChatID) {
		return model.ChannelResolution{Reason: "target_identity_changed"}, nil
	}
	if !c.serviceURL(data.ServiceURL) {
		return model.ChannelResolution{Reason: "untrusted_service_origin"}, nil
	}
	data.ReplyToID = address.ThreadID
	target := model.ReplyTarget{Channel: model.MSTeams, AccountID: c.account.ID, ChatID: address.ChatID, ThreadID: address.ThreadID, Data: common.Data(data)}
	if known {
		target.ReplyToID = learned.ReplyToID
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

type identity struct {
	ID   string `json:"id"`
	Role string `json:"role,omitempty"`
}

type conversation struct {
	ID       string `json:"id"`
	TenantID string `json:"tenantId,omitempty"`
	Type     string `json:"conversationType,omitempty"`
}

type attachment struct {
	ContentType string          `json:"contentType"`
	ContentURL  string          `json:"contentUrl,omitempty"`
	Name        string          `json:"name,omitempty"`
	Content     json.RawMessage `json:"content,omitempty"`
}

type activity struct {
	Type         string       `json:"type"`
	ID           string       `json:"id,omitempty"`
	ChannelID    string       `json:"channelId"`
	ServiceURL   string       `json:"serviceUrl,omitempty"`
	From         identity     `json:"from"`
	Recipient    identity     `json:"recipient"`
	Conversation conversation `json:"conversation"`
	ChannelData  struct {
		Tenant struct {
			ID string `json:"id"`
		} `json:"tenant"`
	} `json:"channelData"`
	Text        string          `json:"text,omitempty"`
	TextFormat  string          `json:"textFormat,omitempty"`
	ReplyToID   string          `json:"replyToId,omitempty"`
	Name        string          `json:"name,omitempty"`
	Value       json.RawMessage `json:"value,omitempty"`
	Attachments []attachment    `json:"attachments,omitempty"`
	Entities    []any           `json:"entities,omitempty"`
}

func (c *Channel) activities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		w.WriteHeader(401)
		return
	}
	raw, err := common.ReadBounded(r.Body, 1024*1024)
	if err != nil {
		w.WriteHeader(413)
		return
	}
	var input activity
	if json.Unmarshal(raw, &input) != nil || input.Conversation.ID == "" || input.From.ID == "" {
		w.WriteHeader(400)
		return
	}
	if !c.validActivity(input) {
		w.WriteHeader(403)
		return
	}
	if err = c.client.Authenticate(r.Context(), r.Header.Get("Authorization"), input.ServiceURL); err != nil {
		w.WriteHeader(401)
		return
	}
	if !common.Contains(c.account.AllowedSenders, input.From.ID) {
		w.WriteHeader(200)
		return
	}
	if common.Contains([]string{"message", "conversationUpdate", "installationUpdate"}, input.Type) {
		data := targetData{AppID: c.config.AppID, ServiceURL: input.ServiceURL, ConversationID: input.Conversation.ID, TenantID: c.config.TenantID, BotID: c.config.BotID, UserID: input.From.ID, Personal: input.Conversation.Type == "personal"}
		if err = common.SaveState(r.Context(), c.host.State(), c.conversationKey(input.Conversation.ID), data, nil); err != nil {
			w.WriteHeader(503)
			return
		}
	}
	if input.Type == "invoke" && input.Name == "fileConsent/invoke" {
		if err = c.acceptConsent(r.Context(), input); err != nil {
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(200)
		return
	}
	if !c.userMessage(input) {
		w.WriteHeader(200)
		return
	}
	if input.ID == "" {
		w.WriteHeader(400)
		return
	}
	if err = c.receive(r.Context(), input); err != nil {
		if common.PolicyRejection(err) {
			w.WriteHeader(200)
		} else {
			w.WriteHeader(503)
		}
		return
	}
	w.WriteHeader(200)
}

func (c *Channel) validActivity(input activity) bool {
	return input.ChannelID == "msteams" && input.Recipient.ID == c.config.BotID && input.ChannelData.Tenant.ID == c.config.TenantID && (input.Conversation.TenantID == "" || input.Conversation.TenantID == c.config.TenantID) && c.serviceURL(input.ServiceURL)
}

func (c *Channel) userMessage(input activity) bool {
	return input.Type == "message" && input.From.ID != c.config.BotID && (input.Text != "" || len(input.Attachments) != 0)
}

func (c *Channel) receive(ctx context.Context, input activity) error {
	media, err := c.downloadAttachments(ctx, input.Attachments)
	if err != nil {
		return err
	}
	data := targetData{AppID: c.config.AppID, ServiceURL: input.ServiceURL, ConversationID: input.Conversation.ID, TenantID: c.config.TenantID, BotID: c.config.BotID, UserID: input.From.ID, ReplyToID: input.ReplyToID, Personal: input.Conversation.Type == "personal"}
	if data.ReplyToID == "" {
		data.ReplyToID = input.ID
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.MSTeams, AccountID: c.account.ID, EventID: input.Conversation.ID + ":" + input.ID}, SenderID: input.From.ID, Text: input.Text, Attachments: media, Target: model.ReplyTarget{Channel: model.MSTeams, AccountID: c.account.ID, ChatID: input.Conversation.ID, ThreadID: input.ReplyToID, ReplyToID: input.ID, Data: common.Data(data)}, ReceivedAt: time.Now(), Context: common.Data(map[string]string{"tenantId": c.config.TenantID})})
}

func (c *Channel) outbound(input model.SendInput, target targetData, media *attachment) activity {
	message := activity{Type: "message", ChannelID: "msteams", From: identity{ID: target.BotID}, Recipient: identity{ID: target.UserID, Role: "user"}, Conversation: conversation{ID: target.ConversationID, TenantID: target.TenantID}, Text: input.Chunk.Text, TextFormat: "extendedmarkdown"}
	message.ChannelData.Tenant.ID = target.TenantID
	if input.Reply != nil && input.Target.ReplyToID != "" {
		message.Text = `<quoted messageId="` + html.EscapeString(input.Target.ReplyToID) + `"/>`
		if input.Chunk.Text != "" {
			message.Text += " " + input.Chunk.Text
		}
		message.Entities = []any{map[string]any{"type": "quotedReply", "quotedReply": map[string]string{"messageId": input.Target.ReplyToID}}}
	}
	message.ReplyToID = input.Target.ThreadID
	if message.ReplyToID == "" && input.Reply != nil {
		message.ReplyToID = input.Target.ReplyToID
	}
	if media != nil {
		message.Attachments = []attachment{*media}
	}
	return message
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	var target targetData
	if !c.sendTarget(input, &target) {
		return common.Reject("invalid_target"), nil
	}
	if !c.serviceURL(target.ServiceURL) {
		return common.Reject("untrusted_service_origin"), nil
	}
	if code := common.ValidateRich(input, richLimits, model.UTF16, common.MediaLimit(c.host)); code != "" {
		return common.Reject(code), nil
	}
	if _, err := c.client.AccessToken(ctx); err != nil {
		return common.Failure(err, true), nil
	}
	prepared, err := c.prepareAttachment(ctx, input, target)
	if err != nil {
		return common.Failure(err, true), nil
	}
	if prepared.outcome != nil {
		return *prepared.outcome, nil
	}
	media := prepared.attachment
	if len(input.Chunk.RichText) > 0 {
		rich, err := c.richAttachment(ctx, input)
		if err != nil {
			if common.Contains([]string{"media_publication_unavailable", "invalid_publication_url", "rich_text_limit_exceeded"}, err.Error()) {
				return common.Reject(err.Error()), nil
			}
			return common.Failure(err, true), nil
		}
		media = rich
	}
	message := c.outbound(input, target, media)
	if err = ctx.Err(); err != nil {
		return common.Retry("send_cancelled_before_transmit", 0), nil
	}
	id, err := c.client.Activity(ctx, target.ServiceURL, target.ConversationID, message.ReplyToID, message)
	if err != nil {
		result := common.Failure(err, false)
		if prepared.consentKey != "" && (result.ErrorCode == "oauth_token_rejected" || result.ErrorCode == "rate_limited") {
			if err = c.consentRefused(ctx, prepared.consentKey); err != nil {
				return model.SendResult{}, err
			}
		}
		return result, nil
	}
	if prepared.consentKey != "" {
		if err = c.consentPosted(ctx, prepared.consentKey); err != nil {
			return model.SendResult{}, err
		}
		return model.SendResult{Status: model.Pending, RetryAfter: 30 * time.Second}, nil
	}
	return common.Sent(id), nil
}

func (c *Channel) sendTarget(input model.SendInput, target *targetData) bool {
	return input.Target.Channel == model.MSTeams && input.Target.AccountID == c.account.ID && json.Unmarshal(input.Target.Data, target) == nil && c.valid(*target, input.Target.ChatID) && (input.Target.ThreadID == "" || target.ReplyToID == input.Target.ThreadID) && (input.Reply == nil || platformID(input.Target.ReplyToID))
}
