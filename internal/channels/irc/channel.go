// Package irc implements an authenticated native IRC/IRCv3 connection.
package irc

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	wire "gopkg.in/irc.v4"
)

type SASL struct {
	Username string          `json:"username"`
	Password model.SecretRef `json:"password"`
}

type Config struct {
	Server                 string           `json:"server"`
	Port                   int              `json:"port,omitempty"`
	TLS                    *bool            `json:"tls,omitempty"`
	AllowInsecureLocalhost bool             `json:"allowInsecureLocalhost,omitempty"`
	Nick                   string           `json:"nick"`
	Password               *model.SecretRef `json:"password,omitempty"`
	SASL                   *SASL            `json:"sasl,omitempty"`
	AllowNickFallback      bool             `json:"allowNickFallback,omitempty"`
}

func nickname(value string) bool {
	if len(value) == 0 || len(value) > 30 {
		return false
	}
	for i, r := range value {
		letter := r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z'
		special := strings.ContainsRune("_[]\\`^{}|", r)
		if !letter && !special && !(i > 0 && (r >= '0' && r <= '9' || r == '-')) {
			return false
		}
	}
	return true
}

func channelName(value string) bool {
	return len(value) >= 2 && len(value) <= 90 && (value[0] == '#' || value[0] == '&') && !strings.ContainsAny(value, " \t\r\n\x00,:")
}

func parseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if err := common.DecodeConfig(raw, &cfg); err != nil {
		return cfg, err
	}
	if cfg.Port == 0 {
		cfg.Port = 6697
	}
	if cfg.TLS == nil {
		enabled := true
		cfg.TLS = &enabled
	}
	if cfg.Server == "" || len(cfg.Server) > 253 || strings.ContainsAny(cfg.Server, " /@?#\r\n\x00") || cfg.Port < 1 || cfg.Port > 65535 || !nickname(cfg.Nick) {
		return cfg, errors.New("invalid_irc_identity")
	}
	local := cfg.Server == "localhost" || cfg.Server == "127.0.0.1" || cfg.Server == "::1"
	if !*cfg.TLS && !(local && cfg.AllowInsecureLocalhost) {
		return cfg, errors.New("irc_tls_required")
	}
	if err := validateSecrets(cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func validateSecrets(cfg Config) error {
	if cfg.Password != nil {
		if err := config.ValidateSecretRef(*cfg.Password, "password"); err != nil {
			return err
		}
	}
	if cfg.SASL != nil {
		if cfg.SASL.Username == "" || len(cfg.SASL.Username) > 128 || strings.ContainsAny(cfg.SASL.Username, "\x00\r\n") {
			return errors.New("invalid_sasl_username")
		}
		if err := config.ValidateSecretRef(cfg.SASL.Password, "sasl.password"); err != nil {
			return err
		}
	}
	return nil
}

func ValidateConfig(raw json.RawMessage) error { _, err := parseConfig(raw); return err }

type Channel struct {
	host      model.ChannelHost
	account   model.AccountConfig
	config    Config
	options   common.Options
	channels  []string
	lifecycle common.Lifecycle
	mu        sync.RWMutex
	current   *connection
}

func New(host model.ChannelHost, account model.AccountConfig, options common.Options) (*Channel, error) {
	cfg, err := parseConfig(account.Config)
	if err != nil {
		return nil, err
	}
	if account.Channel != model.IRC || account.ID == "" {
		return nil, errors.New("invalid_channel_account")
	}
	c := &Channel{host: host, account: account, config: cfg, options: options}
	for _, chat := range host.BoundChatIDs() {
		if strings.HasPrefix(chat, "dm:") {
			continue
		}
		if !channelName(chat) {
			return nil, errors.New("invalid_bound_channel")
		}
		if !common.Contains(c.channels, chat) {
			c.channels = append(c.channels, chat)
		}
	}
	if len(c.channels) > 100 {
		return nil, errors.New("too_many_bound_channels")
	}
	return c, nil
}

func (c *Channel) Kind() model.ChannelKind { return model.IRC }

func (c *Channel) Capabilities() model.ChannelCapabilities {
	return model.ChannelCapabilities{Transport: model.ConnectionTransport, MaxTextLength: 400, LengthUnit: model.UTF8, Media: model.MediaCapabilities{Receive: []model.MediaKind{}, Send: []model.MediaKind{}}}
}

func (c *Channel) Start(ctx context.Context) error { return c.lifecycle.Start(ctx, c.loop) }

func (c *Channel) Close(ctx context.Context) error { return c.lifecycle.Close(ctx) }

func (c *Channel) socket() *connection { c.mu.RLock(); defer c.mu.RUnlock(); return c.current }

type sessionState struct {
	Ready                    bool
	MessageTags, AccountTags bool
	Nick, CaseMapping        string
	HostLength, UserLength   int
}

func (c *Channel) snapshot() sessionState {
	if current := c.socket(); current != nil {
		return current.snapshot()
	}
	return sessionState{Nick: c.config.Nick, CaseMapping: "rfc1459", HostLength: 253}
}

func fold(value, mapping string) string {
	var out strings.Builder
	for _, r := range value {
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		if mapping != "ascii" {
			switch r {
			case '[':
				r = '{'
			case ']':
				r = '}'
			case '\\':
				r = '|'
			case '^':
				if mapping == "rfc1459" {
					r = '~'
				}
			}
		}
		out.WriteRune(r)
	}
	return out.String()
}

type targetData struct {
	Recipient string `json:"recipient"`
	Server    string `json:"server"`
	Port      int    `json:"port"`
	TLS       bool   `json:"tls"`
}

func (c *Channel) target(recipient string) targetData {
	return targetData{Recipient: recipient, Server: c.config.Server, Port: c.config.Port, TLS: *c.config.TLS}
}

func (c *Channel) validTarget(target model.ReplyTarget, mapping string) (targetData, bool) {
	var data targetData
	if target.Channel != model.IRC || target.AccountID != c.account.ID || target.ThreadID != "" || json.Unmarshal(target.Data, &data) != nil || data.Server != c.config.Server || data.Port != c.config.Port || data.TLS != *c.config.TLS {
		return data, false
	}
	chat := data.Recipient
	if !channelName(chat) {
		if !nickname(chat) {
			return data, false
		}
		chat = "dm:" + chat
	}
	return data, fold(chat, mapping) == fold(target.ChatID, mapping)
}

func (c *Channel) Resolve(_ context.Context, address model.ChannelAddress, learned *model.ReplyTarget) (model.ChannelResolution, error) {
	state := c.snapshot()
	recipient := address.ChatID
	direct := strings.HasPrefix(recipient, "dm:")
	if direct {
		recipient = strings.TrimPrefix(recipient, "dm:")
		if state.CaseMapping == "rfc1459" {
			recipient = strings.ReplaceAll(recipient, "~", "^")
		}
	}
	valid := channelName(recipient)
	if direct {
		valid = nickname(recipient)
	}
	if !valid || address.Platform != model.IRC || address.AccountID != c.account.ID || address.ThreadID != "" {
		return model.ChannelResolution{Reason: "invalid_address"}, nil
	}
	target := model.ReplyTarget{Channel: model.IRC, AccountID: c.account.ID, ChatID: address.ChatID, Data: common.Data(c.target(recipient))}
	if learned != nil {
		if _, ok := c.validTarget(*learned, state.CaseMapping); !ok || fold(learned.ChatID, state.CaseMapping) != fold(address.ChatID, state.CaseMapping) {
			return model.ChannelResolution{Reason: "target_identity_changed"}, nil
		}
		target = *learned
	}
	return model.ChannelResolution{Available: true, Target: &target}, nil
}

func relayPrefix(state sessionState, configuredNick string) int {
	return len(":"+state.Nick+"!@ ") + max(state.UserLength, len(configuredNick)+1) + state.HostLength
}

func (c *Channel) SplitText(value string, target model.ReplyTarget) ([]string, error) {
	if _, err := markdown(value); err != nil {
		return nil, err
	}
	state := c.snapshot()
	data, ok := c.validTarget(target, state.CaseMapping)
	if !ok {
		return nil, errors.New("invalid_target")
	}
	limit := min(400, 510-relayPrefix(state, c.config.Nick)-len("PRIVMSG "+data.Recipient+" :"))
	return text.SplitByRendered(value, limit, model.UTF8, func(value string) string {
		rendered, err := markdown(value)
		if err != nil {
			return value
		}
		return rendered
	})
}

func (c *Channel) Send(ctx context.Context, input model.SendInput) (model.SendResult, error) {
	current := c.socket()
	state := sessionState{Nick: c.config.Nick, CaseMapping: "rfc1459", HostLength: 253}
	if current != nil {
		state = current.snapshot()
	}
	target, ok := c.validTarget(input.Target, state.CaseMapping)
	if !ok {
		return common.Reject("target_identity_changed"), nil
	}
	if input.Chunk.Media != nil || len(input.Chunk.RichText) > 0 {
		return common.Reject("media_unsupported"), nil
	}
	value, err := markdown(input.Chunk.Text)
	if err != nil {
		return common.Reject("invalid_irc_text"), nil
	}
	message := &wire.Message{Command: "PRIVMSG", Params: []string{target.Recipient, value}}
	if len(message.String())+2+relayPrefix(state, c.config.Nick) > 512 {
		return common.Reject("relayed_line_too_large"), nil
	}
	if input.Reply != nil && state.MessageTags && input.Target.ReplyToID != "" {
		message.Tags = wire.Tags{"+reply": input.Target.ReplyToID}
	}
	if err = validWire(message.String()); err != nil {
		return common.Reject("invalid_irc_text"), nil
	}
	if current == nil || !state.Ready || ctx.Err() != nil {
		return common.Retry("not_connected", time.Second), nil
	}
	transmitted, err := current.write(ctx, message)
	if err != nil {
		if !transmitted {
			return common.Retry("send_cancelled_before_transmit", time.Second), nil
		}
		return model.SendResult{Status: model.Unknown, ErrorCode: "socket_send_uncertain"}, nil
	}
	return model.SendResult{Status: model.Sent, Receipt: &model.SendReceipt{Data: common.Data(map[string]string{"acknowledgement": "socket_write"})}}, nil
}

func (c *Channel) receive(ctx context.Context, current *connection, message *wire.Message) error {
	state := current.snapshot()
	if !state.Ready || message.Prefix == nil || len(message.Params) < 2 {
		return nil
	}
	sender, destination, value := message.Prefix.Name, message.Params[0], message.Params[1]
	if !nickname(sender) || fold(sender, state.CaseMapping) == fold(state.Nick, state.CaseMapping) || value == "" || strings.HasPrefix(value, "\x01") {
		return nil
	}
	chat := ""
	for _, bound := range c.channels {
		if fold(bound, state.CaseMapping) == fold(destination, state.CaseMapping) {
			chat = bound
			break
		}
	}
	recipient := chat
	if chat == "" {
		if fold(destination, state.CaseMapping) != fold(state.Nick, state.CaseMapping) {
			return nil
		}
		recipient = sender
		chat = "dm:" + fold(sender, state.CaseMapping)
	}
	account := message.Tags["account"]
	authenticated := state.AccountTags && account != "" && account != "*"
	if !authenticated && !c.config.AllowNickFallback {
		return nil
	}
	senderID := "account:" + account
	if !authenticated {
		senderID = "nick:" + fold(sender, state.CaseMapping)
	}
	if !common.Contains(c.account.AllowedSenders, senderID) {
		return nil
	}
	eventID := message.Tags["msgid"]
	if eventID == "" {
		eventID = common.RandomID()
	}
	received := time.Now()
	if parsed, err := time.Parse(time.RFC3339Nano, message.Tags["time"]); err == nil {
		received = parsed
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.IRC, AccountID: c.account.ID, EventID: eventID}, SenderID: senderID, Text: value, ReceivedAt: received, Target: model.ReplyTarget{Channel: model.IRC, AccountID: c.account.ID, ChatID: chat, ReplyToID: message.Tags["msgid"], Data: common.Data(c.target(recipient))}})
}

func (c *Channel) address() string {
	return net.JoinHostPort(c.config.Server, strconv.Itoa(c.config.Port))
}
