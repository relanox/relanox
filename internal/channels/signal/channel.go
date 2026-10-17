// Package signal connects to signal-cli's native HTTP JSON-RPC/SSE daemon.
package signal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/relanox/relanox/internal/transport"
)

type Config struct {
	ServiceURL             string           `json:"serviceUrl"`
	Account                string           `json:"account"`
	SelfUUID               string           `json:"selfUuid,omitempty"`
	Authorization          *model.SecretRef `json:"authorization,omitempty"`
	AllowInsecureLocalhost bool             `json:"allowInsecureLocalhost,omitempty"`
}

func platformID(value string) bool {
	return value != "" && len(value) <= 240 && !strings.ContainsAny(value, "\r\n\x00")
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	if !platformID(cfg.Account) || (cfg.SelfUUID != "" && !platformID(cfg.SelfUUID)) {
		return cfg, errors.New("invalid_signal_identity")
	}
	if cfg.Authorization != nil {
		if err := config.ValidateSecretRef(*cfg.Authorization, "authorization"); err != nil {
			return cfg, err
		}
	}
	cfg.ServiceURL = strings.TrimRight(cfg.ServiceURL, "/")
	u, err := url.Parse(cfg.ServiceURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return cfg, errors.New("invalid_service_url")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local && cfg.AllowInsecureLocalhost) {
		return cfg, errors.New("insecure_service_url")
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
	if account.Channel != model.Signal || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	client := options.HTTPClient
	if client == nil {
		u, _ := url.Parse(cfg.ServiceURL)
		client = transport.NewClient(transport.Options{Timeout: 125 * time.Second, AllowPrivateHosts: []string{u.Hostname()}, TLSClientConfig: options.TLSClientConfig})
	}
	return &Channel{host: host, account: account, config: cfg, options: options, client: common.HTTPClient(client)}, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.Signal }

func (c *Channel) Capabilities() model.ChannelCapabilities {
	return model.ChannelCapabilities{Transport: model.ConnectionTransport, MaxTextLength: 16000, LengthUnit: model.UTF8, Media: model.MediaCapabilities{Receive: common.AllMedia(), Send: common.AllMedia()}}
}

func (c *Channel) SplitText(value string, _ model.ReplyTarget) ([]string, error) {
	return text.SplitByRendered(value, 16000, model.UTF8, func(s string) string { return markdown(s).Message })
}

func (c *Channel) Start(ctx context.Context) error { return c.lifecycle.Start(ctx, c.loop) }

func (c *Channel) Close(ctx context.Context) error {
	c.client.CloseIdleConnections()
	return c.lifecycle.Close(ctx)
}

func (c *Channel) headers() (http.Header, error) {
	headers := make(http.Header)
	if c.config.Authorization != nil {
		value, err := c.options.Secret(*c.config.Authorization)
		if err != nil {
			return nil, err
		}
		if value == "" || strings.ContainsAny(value, "\r\n") {
			return nil, errors.New("invalid_authorization")
		}
		headers.Set("Authorization", value)
	}
	return headers, nil
}

type quote struct {
	Author    string `json:"author"`
	Timestamp int64  `json:"timestamp"`
	Text      string `json:"text"`
}

type targetData struct {
	Kind       string `json:"kind"`
	Recipient  string `json:"recipient,omitempty"`
	GroupID    string `json:"groupId,omitempty"`
	ServiceURL string `json:"serviceUrl"`
	Account    string `json:"account"`
	Quote      *quote `json:"quote,omitempty"`
}

func (c *Channel) target(chatID string) (targetData, bool) {
	target := targetData{ServiceURL: c.config.ServiceURL, Account: c.config.Account}
	switch {
	case strings.HasPrefix(chatID, "group:"):
		target.Kind = "group"
		target.GroupID = strings.TrimPrefix(chatID, "group:")
		return target, platformID(target.GroupID)
	case strings.HasPrefix(chatID, "direct:"):
		target.Kind = "direct"
		target.Recipient = strings.TrimPrefix(chatID, "direct:")
		return target, platformID(target.Recipient)
	}
	return target, false
}

func (c *Channel) validTarget(target model.ReplyTarget) (targetData, bool) {
	var value targetData
	expected, ok := c.target(target.ChatID)
	if !ok || target.Channel != model.Signal || target.AccountID != c.account.ID || target.ThreadID != "" || json.Unmarshal(target.Data, &value) != nil {
		return value, false
	}
	return value, value.Kind == expected.Kind && value.Recipient == expected.Recipient && value.GroupID == expected.GroupID && value.ServiceURL == expected.ServiceURL && value.Account == expected.Account
}

func (c *Channel) Resolve(_ context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	data, ok := c.target(address.ChatID)
	if !ok || address.Platform != model.Signal || address.AccountID != c.account.ID || address.ThreadID != "" {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	target := model.ReplyTarget{Channel: model.Signal, AccountID: c.account.ID, ChatID: address.ChatID, Data: common.Data(data)}
	if learned != nil {
		if _, ok = c.validTarget(*learned); !ok || learned.ChatID != address.ChatID {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		target = *learned
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

type attachment struct {
	ID          *string `json:"id"`
	ContentType string  `json:"contentType"`
	Filename    *string `json:"filename,omitempty"`
	Size        *int64  `json:"size,omitempty"`
}

type dataMessage struct {
	Timestamp   int64        `json:"timestamp"`
	Message     string       `json:"message,omitempty"`
	Attachments []attachment `json:"attachments,omitempty"`
	GroupInfo   *struct {
		ID string `json:"groupId"`
	} `json:"groupInfo,omitempty"`
	ViewOnce bool `json:"viewOnce,omitempty"`
}

type envelope struct {
	Source       string       `json:"source,omitempty"`
	SourceNumber string       `json:"sourceNumber,omitempty"`
	SourceUUID   string       `json:"sourceUuid,omitempty"`
	Timestamp    int64        `json:"timestamp"`
	Message      *dataMessage `json:"dataMessage,omitempty"`
}

type receiveEvent struct {
	Envelope  *envelope       `json:"envelope,omitempty"`
	Exception json.RawMessage `json:"exception,omitempty"`
	Account   string          `json:"account,omitempty"`
}

func (c *Channel) receive(ctx context.Context, raw []byte) error {
	var event receiveEvent
	if json.Unmarshal(raw, &event) != nil {
		return errors.New("invalid_receive_event")
	}
	if len(event.Exception) > 0 && string(event.Exception) != "null" {
		return nil
	}
	if event.Envelope == nil {
		return errors.New("missing_envelope")
	}
	if event.Account != "" && event.Account != c.config.Account {
		return nil
	}
	envelope := event.Envelope
	sender := envelope.SourceUUID
	if sender == "" {
		sender = envelope.SourceNumber
	}
	if sender == "" {
		sender = envelope.Source
	}
	if !c.acceptsSender(sender, *envelope) {
		return nil
	}
	message := envelope.Message
	if message.ViewOnce || (message.Message == "" && len(message.Attachments) == 0) {
		return nil
	}
	if message.Timestamp < 0 || envelope.Timestamp < 0 {
		return errors.New("invalid_native_timestamp")
	}
	chatID := "direct:" + sender
	groupID := ""
	if message.GroupInfo != nil {
		groupID = message.GroupInfo.ID
		if !platformID(groupID) {
			return errors.New("invalid_group_id")
		}
		chatID = "group:" + groupID
	}
	attachments, err := c.receiveAttachments(ctx, message.Attachments, sender, groupID)
	if err != nil {
		return err
	}
	target, _ := c.target(chatID)
	target.Quote = &quote{Author: sender, Timestamp: message.Timestamp, Text: message.Message}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.Signal, AccountID: c.account.ID, EventID: sender + ":" + strconv.FormatInt(message.Timestamp, 10) + ":" + chatID}, SenderID: sender, Text: message.Message, Attachments: attachments, ReceivedAt: time.UnixMilli(envelope.Timestamp), Target: model.ReplyTarget{Channel: model.Signal, AccountID: c.account.ID, ChatID: chatID, Data: common.Data(target)}})
}

func (c *Channel) acceptsSender(sender string, envelope envelope) bool {
	return platformID(sender) && envelope.Message != nil && !c.self(envelope) && slices.Contains(c.account.AllowedSenders, sender)
}

func (c *Channel) self(envelope envelope) bool {
	for _, value := range []string{envelope.Source, envelope.SourceNumber, envelope.SourceUUID} {
		if value != "" && (value == c.config.Account || c.config.SelfUUID != "" && value == c.config.SelfUUID) {
			return true
		}
	}
	return false
}
