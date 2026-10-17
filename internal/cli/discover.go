package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/wecom"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/spf13/cobra"
)

func (c *command) discoverCommand() *cobra.Command {
	var account, botID, env, file string
	var timeout time.Duration
	cmd := &cobra.Command{Use: "discover", Short: "Discover WeCom native chat/sender IDs without forwarding content", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if timeout < time.Second || timeout > 10*time.Minute {
			return problem("invalid_discovery_timeout")
		}
		path, err := c.configPath()
		if err != nil {
			return err
		}
		cfg, selected, err := discoveryAccount(path, account, botID, env, file)
		if err != nil {
			return err
		}
		host := &discoveryHost{command: c, seen: map[model.DiscoveredConversation]bool{}}
		channel, err := wecom.New(host, selected, common.Options{ResolveSecret: cfg.ResolveSecret})
		if err != nil {
			return problem("invalid_wecom_configuration")
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), timeout)
		defer cancel()
		if err = channel.Start(ctx); err != nil {
			return problem("discovery_start_failed")
		}
		defer func() {
			closeCtx, closeCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer closeCancel()
			_ = channel.Close(closeCtx)
		}()
		if !c.json {
			fmt.Fprintln(c.options.Err, "Send a message to the WeCom bot. Only native chat and sender IDs will be printed.")
		}
		<-ctx.Done()
		if cmd.Context().Err() != nil {
			return nil
		}
		return c.output(map[string]any{"event": "discovery_complete", "reason": "timeout"}, "Discovery finished")
	}}
	cmd.Flags().StringVar(&account, "account", "", "Configured WeCom account ID (allowlist/binding may be absent)")
	cmd.Flags().StringVar(&botID, "bot-id", "", "Bot ID for discovery before account setup")
	cmd.Flags().StringVar(&env, "secret-env", "", "Environment variable containing bot secret")
	cmd.Flags().StringVar(&file, "secret-file", "", "Bot secret file relative to configuration")
	cmd.Flags().DurationVar(&timeout, "timeout", 2*time.Minute, "Discovery duration (1s-10m)")
	return cmd
}

func discoveryAccount(path, account, botID, env, file string) (config.Config, model.AccountConfig, error) {
	cfg := config.Config{Path: path}
	selected := model.AccountConfig{ID: "discover", Channel: model.WeCom}
	if account != "" {
		data, err := boundedFile(path, config.MaxConfigBytes)
		if err != nil {
			return cfg, selected, problem("config_unreadable")
		}
		// Discovery intentionally accepts an otherwise unfinished document. It
		// validates only the selected native websocket account and never starts core.
		var draft struct {
			Accounts []model.AccountConfig `json:"accounts"`
		}
		if json.Unmarshal(data, &draft) != nil {
			return cfg, selected, problem("config_invalid")
		}
		found := false
		for _, candidate := range draft.Accounts {
			if candidate.ID == account {
				selected = candidate
				found = true
				break
			}
		}
		if !found || selected.Channel != model.WeCom {
			return cfg, selected, problem("wecom_account_required")
		}
	} else {
		if botID == "" {
			return cfg, selected, problem("account_or_bot_credentials_required")
		}
		selected.Config, _ = json.Marshal(wecom.Config{BotID: botID, Secret: model.SecretRef{Env: env, File: file}})
	}
	if err := wecom.ValidateConfig(selected.Config); err != nil {
		return cfg, selected, problem("invalid_wecom_configuration")
	}
	var native wecom.Config
	_ = json.Unmarshal(selected.Config, &native)
	if native.Mode != "" && native.Mode != "websocket" {
		return cfg, selected, problem("discovery_requires_wecom_websocket")
	}
	if _, err := cfg.ResolveSecret(native.Secret); err != nil {
		return cfg, selected, err
	}
	selected.AllowedSenders = nil
	return cfg, selected, nil
}

// The discovery host is a production boundary with no persistence, media,
// forwarding or authorization capability. The channel records addresses before
// checking its empty sender allowlist; content never reaches Ingest.
type discoveryHost struct {
	command *command
	mu      sync.Mutex
	seen    map[model.DiscoveredConversation]bool
}

func (*discoveryHost) PublicURL() string               { return "" }
func (*discoveryHost) State() model.StateStore         { return nil }
func (*discoveryHost) Observer() model.Observer        { return nil }
func (*discoveryHost) MountHTTP(model.HTTPRoute) error { return problem("discovery_http_forbidden") }
func (*discoveryHost) BoundChatIDs() []string          { return nil }

func (*discoveryHost) BoundAddresses() []model.ChannelAddress { return nil }
func (*discoveryHost) MaxMediaBytes() int64                   { return 0 }
func (*discoveryHost) Media() model.ChannelMediaHost          { return nil }
func (*discoveryHost) Ingest(context.Context, model.IngestInput) (model.IngestReceipt, error) {
	return model.IngestReceipt{}, problem("discovery_forwarding_forbidden")
}

func (h *discoveryHost) Connection(status model.ConnectionStatus, code string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	_ = h.command.output(map[string]any{"event": "connection", "status": status, "errorCode": code}, "WeCom: "+string(status))
}

func (h *discoveryHost) DiscoverConversation(_ context.Context, input model.DiscoveredConversation) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.seen[input] {
		return nil
	}
	h.seen[input] = true
	return h.command.output(map[string]any{"event": "conversation", "chatId": input.ChatID, "senderId": input.SenderID, "threadId": input.ThreadID}, fmt.Sprintf("chat=%s sender=%s thread=%s", input.ChatID, input.SenderID, input.ThreadID))
}
