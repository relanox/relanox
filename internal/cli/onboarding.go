package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/app"
	"github.com/relanox/relanox/internal/model"
	"github.com/spf13/cobra"
)

func (c *command) initCommand() *cobra.Command {
	var publicURL string
	cmd := &cobra.Command{Use: "init", Short: "Create an empty native configuration", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		path, err := c.configPath()
		if err != nil {
			return err
		}
		d, err := newDocument(path, publicURL)
		if err != nil {
			return err
		}
		defer d.rollback()
		return c.saved(d)
	}}
	cmd.Flags().StringVar(&publicURL, "public-url", "", "Public HTTPS origin for native callbacks and agent MCP")
	return cmd
}

type addOptions struct {
	id          string
	kind        string
	native      string
	allowed     []string
	credentials string
}

func (c *command) accountCommand() *cobra.Command {
	parent := &cobra.Command{Use: "account", Short: "Manage native channel accounts"}
	var opts addOptions
	add := &cobra.Command{Use: "add", Short: "Add a native account with managed credentials", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		d, err := c.document()
		if err != nil {
			return err
		}
		defer d.rollback()
		if err = c.addAccount(cmd.Context(), d, opts); err != nil {
			return err
		}
		return c.saved(d)
	}}
	add.Flags().StringVar(&opts.id, "id", "", "Local account ID")
	add.Flags().StringVar(&opts.kind, "channel", "", "Native channel name")
	add.Flags().StringVar(&opts.native, "native-config", "", "JSON file containing native options and secret references")
	add.Flags().StringSliceVar(&opts.allowed, "allowed-sender", nil, "Native sender ID allowlist (repeat or comma separate)")
	parent.AddCommand(add)
	return parent
}

func (c *command) addAccount(ctx context.Context, d *document, opts addOptions) error {
	var err error
	if opts.id == "" {
		opts.id, err = c.prompt("Account ID", "", false)
		if err != nil {
			return err
		}
	}
	if opts.kind == "" {
		opts.kind, err = c.prompt("Channel (telegram, wecom, wechat, feishu, qq, dingtalk, msteams, whatsapp, line, signal, irc, matrix, discord, slack, googlechat, mattermost)", "", false)
		if err != nil {
			return err
		}
	}
	for _, a := range d.Accounts {
		if a.ID == opts.id {
			return problem("account_already_exists")
		}
	}
	if model.ChannelKind(opts.kind) == model.WeChat && opts.native == "" {
		return c.pairWechat(ctx, d, opts.id, wechatLogin{timeout: 10 * time.Minute})
	}
	if len(opts.allowed) == 0 {
		value, err := c.prompt("Allowed native sender IDs (comma separated)", "", false)
		if err != nil {
			return err
		}
		opts.allowed = splitList(value)
	}
	raw, err := readNative(opts.native)
	if err != nil {
		return err
	}
	if raw == nil {
		raw, err = c.accountForm(d, opts.id, model.ChannelKind(opts.kind))
		if err != nil {
			return err
		}
	}
	account := model.AccountConfig{ID: opts.id, Channel: model.ChannelKind(opts.kind), AllowedSenders: opts.allowed, Config: raw}
	if err = app.ValidateAccount(account); err != nil {
		return err
	}
	d.Accounts = append(d.Accounts, account)
	return nil
}

func splitList(value string) []string {
	var values []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			values = append(values, item)
		}
	}
	return values
}

func readNative(path string) (json.RawMessage, error) {
	if path == "" {
		return nil, nil
	}
	data, err := boundedFile(path, 1<<20)
	if err != nil || !json.Valid(data) {
		return nil, problem("native_configuration_unreadable_or_invalid")
	}
	return json.RawMessage(data), nil
}

func (c *command) agentCommand() *cobra.Command {
	parent := &cobra.Command{Use: "agent", Short: "Manage hosted agent endpoints"}
	var opts addOptions
	add := &cobra.Command{Use: "add", Short: "Add dot, Grok or Muse", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		d, err := c.document()
		if err != nil {
			return err
		}
		defer d.rollback()
		if err = c.addAgent(d, opts); err != nil {
			return err
		}
		return c.saved(d)
	}}
	add.Flags().StringVar(&opts.id, "id", "", "Local endpoint ID")
	add.Flags().StringVar(&opts.kind, "agent", "", "dot, grok or muse")
	add.Flags().StringVar(&opts.native, "native-config", "", "JSON file containing native options and secret references")
	add.Flags().StringVar(&opts.credentials, "credentials-directory", "", "Existing paired Muse credentials directory")
	parent.AddCommand(add)
	return parent
}

func (c *command) addAgent(d *document, opts addOptions) error {
	var err error
	if opts.id == "" {
		opts.id, err = c.prompt("Endpoint ID", "", false)
		if err != nil {
			return err
		}
	}
	if opts.kind == "" {
		opts.kind, err = c.prompt("Agent (dot, grok, muse)", "dot", false)
		if err != nil {
			return err
		}
	}
	for _, e := range d.Endpoints {
		if e.ID == opts.id {
			return problem("endpoint_already_exists")
		}
	}
	if d.HTTP.PublicURL == "" {
		d.HTTP.PublicURL, err = c.prompt("Public HTTPS origin", "", false)
		if err != nil {
			return err
		}
	}
	raw, err := readNative(opts.native)
	if err != nil {
		return err
	}
	if raw == nil {
		raw, err = c.agentForm(d, opts)
		if err != nil {
			return err
		}
	}
	endpoint := model.EndpointConfig{ID: opts.id, Agent: model.AgentKind(opts.kind), Config: raw}
	if err = app.ValidateEndpoint(endpoint); err != nil {
		return err
	}
	d.Endpoints = append(d.Endpoints, endpoint)
	return nil
}

func (c *command) agentForm(d *document, opts addOptions) (json.RawMessage, error) {
	kind := model.AgentKind(opts.kind)
	if !kind.Valid() {
		return nil, problem("invalid_agent")
	}
	token, err := d.secret(opts.id, "mcp-token", agentmcp.Opaque(), environment(opts.id, "mcpToken"))
	if err != nil {
		return nil, err
	}
	auth := "bearer"
	if kind == model.Dot {
		auth = "oauth"
	}
	fields := map[string]any{"mcp": agentmcp.Config{Auth: auth, Token: token}}
	switch kind {
	case model.Grok:
		for _, field := range []string{"routineUrl", "routineAuthorization"} {
			ref, err := c.secretPrompt(d, opts.id, field, false)
			if err != nil {
				return nil, err
			}
			fields[field] = ref
		}
	case model.Muse:
		if opts.credentials == "" {
			opts.credentials, err = c.prompt("Existing Muse credentials directory (relative to config)", "", false)
			if err != nil {
				return nil, err
			}
		}
		info, err := os.Stat(d.ResolvePath(opts.credentials))
		if err != nil || !info.IsDir() {
			return nil, problem("paired_muse_directory_required")
		}
		fields["credentialsDirectory"] = opts.credentials
	}
	return json.Marshal(fields)
}

func environment(id, field string) string {
	return "RELANOX_" + strings.ToUpper(safeName(id)) + "_" + strings.ToUpper(safeName(field))
}

func (c *command) secretPrompt(d *document, id, field string, generate bool) (model.SecretRef, error) {
	env := environment(id, field)
	if generate {
		return d.secret(id, field, agentmcp.Opaque(), env)
	}
	value, err := c.prompt(field+" (hidden; empty uses "+env+")", "", true)
	if err != nil {
		return model.SecretRef{}, err
	}
	return d.secret(id, field, value, env)
}

type formField struct {
	name     string
	fallback string
	secret   bool
	generate bool
	list     bool
}

func accountFields(kind model.ChannelKind) []formField {
	switch kind {
	case model.Telegram:
		return []formField{{name: "botToken", secret: true}, {name: "webhookSecret", secret: true, generate: true}}
	case model.WeCom:
		return []formField{{name: "botId"}, {name: "secret", secret: true}}
	case model.Feishu:
		return []formField{{name: "appId"}, {name: "tenantKey"}, {name: "appSecret", secret: true}, {name: "verificationToken", secret: true}, {name: "encryptKey", secret: true}}
	case model.DingTalk:
		return []formField{{name: "clientId"}, {name: "robotCode"}, {name: "clientSecret", secret: true}}
	case model.QQ:
		return []formField{{name: "appId"}, {name: "clientSecret", secret: true}}
	case model.MSTeams:
		return []formField{{name: "appId"}, {name: "botId"}, {name: "tenantId"}, {name: "appSecret", secret: true}, {name: "trustedServiceOrigins", list: true}}
	case model.WhatsApp:
		return []formField{{name: "phoneNumberId"}, {name: "businessAccountId"}, {name: "appSecret", secret: true}, {name: "verifyToken", secret: true, generate: true}, {name: "accessToken", secret: true}}
	case model.LINE:
		return []formField{{name: "channelSecret", secret: true}, {name: "accessToken", secret: true}}
	case model.Signal:
		return []formField{{name: "serviceUrl"}, {name: "account"}}
	case model.IRC:
		return []formField{{name: "server"}, {name: "nick"}}
	case model.Matrix:
		return []formField{{name: "homeserver"}, {name: "accessToken", secret: true}}
	case model.Discord:
		return []formField{{name: "botToken", secret: true}}
	case model.Mattermost:
		return []formField{{name: "serverUrl"}, {name: "token", secret: true}}
	default:
		return nil
	}
}

func (c *command) accountForm(d *document, id string, kind model.ChannelKind) (json.RawMessage, error) {
	if kind == model.GoogleChat {
		return c.googleChatForm(d, id)
	}
	if kind == model.Slack {
		return c.slackForm(d, id)
	}
	spec := accountFields(kind)
	if spec == nil {
		return nil, problem("native_config_file_required_for_channel")
	}
	fields := map[string]any{}
	for _, field := range spec {
		if field.secret {
			ref, err := c.secretPrompt(d, id, field.name, field.generate)
			if err != nil {
				return nil, err
			}
			fields[field.name] = ref
			continue
		}
		value, err := c.prompt(field.name, field.fallback, false)
		if err != nil {
			return nil, err
		}
		if field.list {
			fields[field.name] = splitList(value)
		} else {
			fields[field.name] = value
		}
	}
	return json.Marshal(fields)
}

func (c *command) slackForm(d *document, id string) (json.RawMessage, error) {
	appID, err := c.prompt("Slack appId", "", false)
	if err != nil {
		return nil, err
	}
	token, err := c.secretPrompt(d, id, "botToken", false)
	if err != nil {
		return nil, err
	}
	mode, err := c.prompt("Slack transport (socket or events)", "socket", false)
	if err != nil {
		return nil, err
	}
	field := "appToken"
	switch mode {
	case "socket":
	case "events":
		field = "signingSecret"
	default:
		return nil, problem("invalid_slack_transport")
	}
	secret, err := c.secretPrompt(d, id, field, false)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"appId": appID, "botToken": token, field: secret})
}

func (c *command) googleChatForm(d *document, id string) (json.RawMessage, error) {
	path, err := c.prompt("Google service account JSON file", "", false)
	if err != nil {
		return nil, err
	}
	data, err := boundedFile(path, 64<<10)
	if err != nil || !json.Valid(data) {
		return nil, problem("service_account_json_unreadable_or_invalid")
	}
	ref, err := d.secret(id, "serviceAccount", string(data), environment(id, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"serviceAccount": ref})
}

func (c *command) bindCommand() *cobra.Command {
	var binding model.Binding
	cmd := &cobra.Command{Use: "bind", Short: "Bind one native conversation to an endpoint", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		d, err := c.document()
		if err != nil {
			return err
		}
		defer d.rollback()
		if err = c.addBinding(d, binding); err != nil {
			return err
		}
		return c.saved(d)
	}}
	cmd.Flags().StringVar(&binding.AccountID, "account", "", "Account ID")
	cmd.Flags().StringVar(&binding.ChatID, "chat", "", "Native chat/conversation ID")
	cmd.Flags().StringVar(&binding.ThreadID, "thread", "", "Native thread ID")
	cmd.Flags().StringVar(&binding.EndpointID, "endpoint", "", "Endpoint ID")
	cmd.Flags().StringSliceVar(&binding.AllowedSenders, "allowed-sender", nil, "Optional narrower sender allowlist")
	return cmd
}

func (c *command) addBinding(d *document, b model.Binding) error {
	for _, field := range []struct {
		label string
		value *string
	}{{"Account ID", &b.AccountID}, {"Native chat ID", &b.ChatID}, {"Endpoint ID", &b.EndpointID}} {
		if *field.value == "" {
			value, err := c.prompt(field.label, "", false)
			if err != nil {
				return err
			}
			*field.value = value
		}
	}
	for _, existing := range d.Bindings {
		if existing.AccountID == b.AccountID && existing.ChatID == b.ChatID && existing.ThreadID == b.ThreadID {
			return problem("conversation_already_bound")
		}
	}
	d.Bindings = append(d.Bindings, b)
	return nil
}

func (c *command) setupCommand() *cobra.Command {
	return &cobra.Command{Use: "setup", Short: "Interactively configure an account, hosted agent and binding", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		path, err := c.configPath()
		if err != nil {
			return err
		}
		d, err := readDocument(path)
		if err != nil {
			if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
				return err
			}
			d, err = newDocument(path, "")
		}
		if err != nil {
			return err
		}
		defer d.rollback()
		fmt.Fprintln(c.options.Err, "Native IDs are platform-specific. WeChat uses wechat-login; WeCom discovery can find chat and sender IDs before binding.")
		if err = c.addAccount(cmd.Context(), d, addOptions{}); err != nil {
			return err
		}
		if err = c.addAgent(d, addOptions{}); err != nil {
			return err
		}
		if err = c.addBinding(d, model.Binding{}); err != nil {
			return err
		}
		return c.saved(d)
	}}
}
