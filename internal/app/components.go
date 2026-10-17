// Package app composes concrete native components into the durable relay.
package app

import (
	"context"
	"net/http"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/dot"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/agents/muse"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/dingtalk"
	"github.com/relanox/relanox/internal/channels/feishu"
	"github.com/relanox/relanox/internal/channels/irc"
	"github.com/relanox/relanox/internal/channels/line"
	"github.com/relanox/relanox/internal/channels/matrix"
	"github.com/relanox/relanox/internal/channels/msteams"
	"github.com/relanox/relanox/internal/channels/qq"
	"github.com/relanox/relanox/internal/channels/signal"
	"github.com/relanox/relanox/internal/channels/telegram"
	"github.com/relanox/relanox/internal/channels/wechat"
	"github.com/relanox/relanox/internal/channels/wecom"
	"github.com/relanox/relanox/internal/channels/whatsapp"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
)

// ValidateAccount checks the native configuration without loading credentials,
// opening storage, constructing connections or calling platform APIs.
func ValidateAccount(account model.AccountConfig) error {
	var err error
	switch account.Channel {
	case model.Telegram:
		err = telegram.ValidateConfig(account.Config)
	case model.Feishu:
		err = feishu.ValidateConfig(account.Config)
	case model.WeCom:
		err = wecom.ValidateConfig(account.Config)
	case model.WeChat:
		err = wechat.ValidateConfig(account.Config)
	case model.DingTalk:
		err = dingtalk.ValidateConfig(account.Config)
	case model.QQ:
		err = qq.ValidateConfig(account.Config)
	case model.MSTeams:
		err = msteams.ValidateConfig(account.Config)
	case model.WhatsApp:
		err = whatsapp.ValidateConfig(account.Config)
	case model.LINE:
		err = line.ValidateConfig(account.Config)
	case model.Signal:
		err = signal.ValidateConfig(account.Config)
	case model.IRC:
		err = irc.ValidateConfig(account.Config)
	case model.Matrix:
		err = matrix.ValidateConfig(account.Config)
	default:
		return invalid("channel", "component_unavailable")
	}
	if err != nil {
		return nativeDiagnostic(err)
	}
	return nil
}

func ValidateEndpoint(endpoint model.EndpointConfig) error {
	var err error
	switch endpoint.Agent {
	case model.Dot:
		_, err = dot.Validate(endpoint.Config)
	case model.Grok:
		_, err = grok.Validate(endpoint.Config)
	case model.Muse:
		_, err = muse.Validate(endpoint.Config)
	default:
		return invalid("agent", "component_unavailable")
	}
	if err != nil {
		return nativeDiagnostic(err)
	}
	return nil
}

func nativeChannel(host model.ChannelHost, account model.AccountConfig, options common.Options) (model.Channel, error) {
	switch account.Channel {
	case model.Telegram:
		return telegram.New(host, account, options)
	case model.Feishu:
		return feishu.New(host, account, options)
	case model.WeCom:
		return wecom.New(host, account, options)
	case model.WeChat:
		return wechat.New(host, account, options)
	case model.DingTalk:
		return dingtalk.New(host, account, options)
	case model.QQ:
		return qq.New(host, account, options)
	case model.MSTeams:
		return msteams.New(host, account, options)
	case model.WhatsApp:
		return whatsapp.New(host, account, options)
	case model.LINE:
		return line.New(host, account, options)
	case model.Signal:
		return signal.New(host, account, options)
	case model.IRC:
		return irc.New(host, account, options)
	case model.Matrix:
		return matrix.New(host, account, options)
	}
	return nil, invalid("channel", "component_unavailable")
}

func nativeAgent(endpoint model.EndpointConfig, deps agentmcp.Dependencies) (model.Agent, error) {
	switch endpoint.Agent {
	case model.Dot:
		return dot.New(endpoint, deps)
	case model.Grok:
		return grok.New(endpoint, deps)
	case model.Muse:
		return muse.New(endpoint, deps)
	}
	return nil, invalid("agent", "component_unavailable")
}

func attachComponents(runtime *core.Runtime, cfg config.Config, client *http.Client) error {
	for _, account := range cfg.Accounts {
		host, err := runtime.ChannelHost(account.ID)
		if err != nil {
			return err
		}
		channel, err := nativeChannel(host, account, common.Options{HTTPClient: client, ResolveSecret: cfg.ResolveSecret})
		if err != nil {
			return invalid("account", "component_initialization_failed")
		}
		if err = runtime.AttachChannel(account.ID, channel); err != nil {
			channel.Close(context.Background())
			return err
		}
	}
	for _, endpoint := range cfg.Endpoints {
		host, err := runtime.AgentHost(endpoint.Agent)
		if err != nil {
			return err
		}
		agent, err := nativeAgent(endpoint, agentmcp.Dependencies{Host: host, ResolveSecret: cfg.ResolveSecret, ResolvePath: cfg.ResolvePath, HTTPClient: client})
		if err != nil {
			return invalid("endpoint", "component_initialization_failed")
		}
		if err = runtime.AttachAgent(endpoint.ID, agent); err != nil {
			agent.Close(context.Background())
			return err
		}
	}
	return nil
}
