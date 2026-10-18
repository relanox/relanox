// Package cli implements the executable's operator commands and onboarding.
package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

type Error struct{ Code string }

func (e *Error) Error() string { return e.Code }

func problem(code string) error { return &Error{Code: code} }

type outputError struct {
	cause error
	json  bool
}

func (e *outputError) Error() string { return e.cause.Error() }
func (e *outputError) Unwrap() error { return e.cause }

// JSONError reports the command's parsed output choice, including operational
// defaults, so the executable can format failures consistently with successes.
func JSONError(err error) bool {
	var output *outputError
	return errors.As(err, &output) && output.json
}

// Options controls production streams as well as embedders and scripted setup.
type Options struct {
	In      io.Reader
	Out     io.Writer
	Err     io.Writer
	Version string
}

type command struct {
	options Options
	reader  *bufio.Reader
	path    string
	json    bool
	machine bool
}

func Run(ctx context.Context, args []string, options Options) error {
	if options.In == nil {
		options.In = os.Stdin
	}
	if options.Out == nil {
		options.Out = os.Stdout
	}
	if options.Err == nil {
		options.Err = os.Stderr
	}
	c := &command{options: options, reader: bufio.NewReader(options.In)}
	root := &cobra.Command{Use: "relanox", Short: "Durable relay for native channels and hosted agents", SilenceUsage: true, SilenceErrors: true, Version: options.Version}
	root.SetIn(options.In)
	root.SetOut(options.Out)
	root.SetErr(options.Err)
	root.PersistentFlags().StringVarP(&c.path, "config", "c", "", "Configuration path (or RELANOX_CONFIG)")
	root.PersistentFlags().BoolVar(&c.json, "json", false, "Write structured JSON (default for operational commands; --json=false selects text)")
	root.PersistentPreRun = func(cmd *cobra.Command, _ []string) {
		c.selectOutput(root, cmd)
	}
	root.AddCommand(c.validateCommand(), c.initCommand(), c.setupCommand(), c.accountCommand(), c.agentCommand(), c.bindCommand(), c.loginCommand(), c.discoverCommand(), c.statusCommand(), c.requeueCommand(), c.cleanupCommand(), c.doctorCommand(), c.runCommand())
	root.SetArgs(args)
	invoked, err := root.ExecuteContextC(ctx)
	if err == nil {
		return nil
	}
	if invoked == root && !root.Flags().Parsed() {
		// Command discovery can fail before Cobra parses global flags. Read the
		// output choice for diagnostics while retaining the original failure.
		_ = root.ParseFlags(args)
	}
	c.selectOutput(root, invoked)
	return &outputError{cause: classifyCommandError(err, invoked), json: c.structured()}
}

func (c *command) selectOutput(root, invoked *cobra.Command) {
	if invoked == nil || root.PersistentFlags().Changed("json") {
		return
	}
	switch invoked.Name() {
	case "validate", "status", "requeue", "cleanup", "doctor", "discover", "wechat-login":
		c.machine = true
	}
}

func classifyCommandError(err error, invoked *cobra.Command) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	if strings.HasPrefix(message, "unknown command ") {
		if invoked != nil && !invoked.HasSubCommands() {
			return problem("invalid_arguments")
		}
		return problem("invalid_command")
	}
	for _, prefix := range []string{"unknown flag:", "unknown shorthand flag:", "flag needs an argument:", "invalid argument ", "accepts ", "requires ", "required flag"} {
		if strings.HasPrefix(message, prefix) {
			return problem("invalid_arguments")
		}
	}
	return err
}

func (c *command) configPath() (string, error) { return config.Discover(c.path) }

func (c *command) load() (config.Config, error) {
	path, err := c.configPath()
	if err != nil {
		return config.Config{}, err
	}
	return config.Load(path)
}

func (c *command) document() (*document, error) {
	path, err := c.configPath()
	if err != nil {
		return nil, err
	}
	return readDocument(path)
}

func (c *command) output(value any, human string) error {
	if c.structured() {
		return json.NewEncoder(c.options.Out).Encode(value)
	}
	_, err := fmt.Fprintln(c.options.Out, human)
	return err
}

func (c *command) structured() bool { return c.json || c.machine }

func (c *command) prompt(label, fallback string, secret bool) (string, error) {
	if c.json {
		return "", problem("interactive_input_unavailable_with_json")
	}
	prompt := label + ": "
	if fallback != "" {
		prompt = fmt.Sprintf("%s [%s]: ", label, fallback)
	}
	if _, err := io.WriteString(c.options.Err, prompt); err != nil {
		return "", err
	}
	var value string
	if file, ok := c.options.In.(*os.File); ok && secret && term.IsTerminal(int(file.Fd())) {
		data, err := term.ReadPassword(int(file.Fd()))
		_, newlineErr := fmt.Fprintln(c.options.Err)
		if newlineErr != nil {
			return "", newlineErr
		}
		if err != nil {
			return "", problem("input_unavailable")
		}
		value = string(data)
	} else {
		line, err := c.reader.ReadString('\n')
		if err != nil && (!errors.Is(err, io.EOF) || line == "") {
			return "", problem("input_unavailable")
		}
		value = strings.TrimRight(line, "\r\n")
	}
	if value == "" {
		value = fallback
	}
	return value, nil
}

func (c *command) saved(d *document) error {
	backup, err := d.save()
	if err != nil {
		return err
	}
	next := connectionInstructions(d.Config)
	if err = c.output(map[string]any{"status": "saved", "config": d.Path, "backup": backup, "connections": next}, "Saved "+d.Path); err != nil {
		return err
	}
	if !c.structured() {
		for _, instruction := range next {
			if _, err := fmt.Fprintln(c.options.Out, instruction); err != nil {
				return err
			}
		}
	}
	return nil
}

func connectionInstructions(cfg config.Config) []string {
	var result []string
	base := strings.TrimRight(cfg.HTTP.PublicURL, "/")
	for _, endpoint := range cfg.Endpoints {
		url := base + "/agents/" + string(endpoint.Agent) + "/mcp/" + endpoint.ID
		var options struct {
			MCP struct {
				Auth  string          `json:"auth"`
				Token model.SecretRef `json:"token"`
			} `json:"mcp"`
		}
		if json.Unmarshal(endpoint.Config, &options) != nil {
			continue
		}
		auth := options.MCP.Auth
		if auth == "" {
			auth = "bearer"
			if endpoint.Agent == model.Dot {
				auth = "oauth"
			}
		}
		if auth == "path" {
			url += "/<token>"
		}
		result = append(result, "MCP "+endpoint.ID+": "+url+" ("+auth+")")
		ref := options.MCP.Token
		if ref.File != "" {
			result = append(result, "MCP credential "+endpoint.ID+": "+cfg.ResolvePath(ref.File))
		}
		if ref.Env != "" {
			result = append(result, "Environment override "+endpoint.ID+": "+ref.Env)
		}
	}
	for _, account := range cfg.Accounts {
		path := callbackPath(account)
		if path != "" && base != "" {
			result = append(result, "Native callback "+account.ID+": "+base+"/channels/"+string(account.Channel)+"/"+account.ID+path)
		}
	}
	return result
}

func callbackPath(account model.AccountConfig) string {
	switch account.Channel {
	case model.Telegram, model.Feishu, model.WhatsApp, model.LINE, model.GoogleChat:
		return "/webhook"
	case model.MSTeams:
		return "/activities"
	case model.Slack:
		var options struct {
			SigningSecret *model.SecretRef `json:"signingSecret"`
		}
		_ = json.Unmarshal(account.Config, &options)
		if options.SigningSecret != nil {
			return "/events"
		}
	case model.WeCom:
		var options struct {
			Mode string `json:"mode"`
		}
		_ = json.Unmarshal(account.Config, &options)
		if options.Mode == "webhook" {
			return "/webhook"
		}
	}
	return ""
}
