// Package model defines the durable and protocol boundaries shared by Relanox.
// Implementations are composed explicitly; these interfaces do not load extensions.
package model

import "encoding/json"

type ChannelKind string

const (
	Telegram   ChannelKind = "telegram"
	Discord    ChannelKind = "discord"
	Slack      ChannelKind = "slack"
	Feishu     ChannelKind = "feishu"
	WeCom      ChannelKind = "wecom"
	WeChat     ChannelKind = "wechat"
	DingTalk   ChannelKind = "dingtalk"
	QQ         ChannelKind = "qq"
	MSTeams    ChannelKind = "msteams"
	WhatsApp   ChannelKind = "whatsapp"
	Matrix     ChannelKind = "matrix"
	GoogleChat ChannelKind = "googlechat"
	LINE       ChannelKind = "line"
	Mattermost ChannelKind = "mattermost"
	Signal     ChannelKind = "signal"
	IRC        ChannelKind = "irc"
)

func (k ChannelKind) Valid() bool {
	switch k {
	case Telegram, Discord, Slack, Feishu, WeCom, WeChat, DingTalk, QQ, MSTeams, WhatsApp, Matrix, GoogleChat, LINE, Mattermost, Signal, IRC:
		return true
	}
	return false
}

type AgentKind string

const (
	Dot  AgentKind = "dot"
	Grok AgentKind = "grok"
	Muse AgentKind = "muse"
)

func (k AgentKind) Valid() bool { return k == Dot || k == Grok || k == Muse }

// SecretRef selects an environment variable, a managed credential file, or both.
// A nonempty environment value overrides File. Never persist the resolved value.
type SecretRef struct {
	Env  string `json:"env,omitempty"`
	File string `json:"file,omitempty"`
}

type AccountConfig struct {
	ID             string          `json:"id"`
	Channel        ChannelKind     `json:"channel"`
	Config         json.RawMessage `json:"config"`
	AllowedSenders []string        `json:"allowedSenders"`
}

// EndpointConfig is captured with accepted work, including secret references but
// never resolved secrets. Binding changes must not redirect queued work.
type EndpointConfig struct {
	ID     string          `json:"id"`
	Agent  AgentKind       `json:"agent"`
	Config json.RawMessage `json:"config"`
}

type Binding struct {
	AccountID  string `json:"accountId"`
	ChatID     string `json:"chatId"`
	ThreadID   string `json:"threadId,omitempty"`
	EndpointID string `json:"endpointId"`
	// Nil inherits the account allowlist; a configured list must be nonempty.
	AllowedSenders []string `json:"allowedSenders"`
}

type ChannelAddress struct {
	ID        string      `json:"id"`
	Platform  ChannelKind `json:"platform"`
	AccountID string      `json:"accountId"`
	ChatID    string      `json:"chatId"`
	ThreadID  string      `json:"threadId,omitempty"`
}

// ReplyTarget holds a durable native address, never a reply closure.
type ReplyTarget struct {
	Channel   ChannelKind     `json:"channel"`
	AccountID string          `json:"accountId"`
	ChatID    string          `json:"chatId"`
	ThreadID  string          `json:"threadId,omitempty"`
	ReplyToID string          `json:"replyToId,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

type ConversationRecord struct {
	Address  ChannelAddress `json:"address"`
	Endpoint EndpointConfig `json:"endpoint"`
	Target   *ReplyTarget   `json:"target,omitempty"`
}

type Principal struct {
	Subject     string
	EndpointIDs []string
}
