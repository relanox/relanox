package cli

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"time"

	"github.com/relanox/relanox/internal/channels/wechat"
	"github.com/relanox/relanox/internal/model"
	"github.com/spf13/cobra"
)

type wechatLogin struct {
	api          string
	verification string
	insecure     bool
	timeout      time.Duration
}

func (c *command) loginCommand() *cobra.Command {
	var id, api, verification string
	var insecure bool
	var timeout time.Duration
	cmd := &cobra.Command{Use: "wechat-login", Short: "Pair WeChat and save the account and token automatically", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if id == "" {
			value, err := c.prompt("Account ID", "wechat", false)
			if err != nil {
				return err
			}
			id = value
		}
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
		if err = c.pairWechat(cmd.Context(), d, id, wechatLogin{api: api, verification: verification, insecure: insecure, timeout: timeout}); err != nil {
			return err
		}
		return c.saved(d)
	}}
	cmd.Flags().StringVar(&id, "account", "", "Account ID to add or refresh")
	cmd.Flags().StringVar(&api, "api-base", "", "Native WeChat API origin")
	cmd.Flags().StringVar(&verification, "verification-code-file", "", "Read additional verification codes from this file")
	cmd.Flags().BoolVar(&insecure, "allow-insecure-loopback", false, "Allow an explicit local HTTP protocol peer")
	cmd.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "Maximum pairing duration")
	return cmd
}

func (c *command) pairWechat(ctx context.Context, d *document, id string, options wechatLogin) error {
	if err := checkWechatAccount(d, id); err != nil {
		return err
	}
	if options.timeout < time.Second || options.timeout > time.Hour {
		return problem("invalid_login_timeout")
	}
	ctx, cancel := context.WithTimeout(ctx, options.timeout)
	defer cancel()
	if options.verification == "" && !c.json {
		file, err := os.CreateTemp("", "relanox-wechat-verify-*")
		if err != nil {
			return problem("verification_file_unavailable")
		}
		options.verification = file.Name()
		_ = file.Close()
		// Remove the temporary verification input after pairing finishes.
		defer func() { _ = os.Remove(file.Name()) }()
		if err = privatePath(file.Name(), false); err != nil {
			return problem("verification_file_permissions_failed")
		}
	}
	var eventErr error
	event := func(value map[string]any) {
		if eventErr != nil {
			return
		}
		eventErr = c.wechatEvent(value, options.verification)
		if eventErr != nil {
			cancel()
		}
	}
	credentials, err := wechat.Authenticate(ctx, wechat.LoginOptions{APIBase: options.api, AllowInsecureLoopback: options.insecure, VerificationCodeFile: options.verification, Event: event})
	if eventErr != nil {
		return eventErr
	}
	if err != nil {
		return problem(loginError(err))
	}
	if err = saveWechat(d, id, credentials, options.insecure); err != nil {
		return err
	}
	return c.output(map[string]any{"event": "wechat_login_confirmed", "botId": credentials.BotID, "userId": credentials.UserID}, "WeChat paired: bot="+credentials.BotID+" user="+credentials.UserID)
}

func (c *command) wechatEvent(event map[string]any, verification string) error {
	human := "WeChat: " + stringField(event, "event")
	if qr := stringField(event, "qrCode"); qr != "" {
		human = "Scan the WeChat QR code: " + qr
	}
	status := stringField(event, "status")
	if status != "" {
		human = "WeChat login: " + status
	}
	if err := c.output(event, human); err != nil {
		return err
	}
	if status == "need_verifycode" && !c.json {
		value, err := c.prompt("WeChat verification code", "", true)
		if err != nil {
			return err
		}
		if err = os.WriteFile(verification, []byte(value), 0600); err != nil {
			return problem("verification_file_unwritable")
		}
	}
	return nil
}

func stringField(value map[string]any, key string) string { v, _ := value[key].(string); return v }

func loginError(err error) string {
	switch err.Error() {
	case "wechat_login_expired", "wechat_login_verify_code_blocked", "wechat_login_binded_redirect", "wechat_verification_code_file_required", "wechat_login_origin_invalid":
		return err.Error()
	}
	if err == context.DeadlineExceeded {
		return "wechat_login_timeout"
	}
	if err == context.Canceled {
		return "wechat_login_cancelled"
	}
	return "wechat_login_failed"
}

func checkWechatAccount(d *document, id string) error {
	for _, account := range d.Accounts {
		if account.ID == id && account.Channel != model.WeChat {
			return problem("account_belongs_to_another_channel")
		}
	}
	return nil
}

func saveWechat(d *document, id string, credentials wechat.Credentials, insecure bool) error {
	if credentials.BotID == "" || credentials.BotToken == "" || credentials.UserID == "" {
		return problem("wechat_credentials_incomplete")
	}
	ref, err := d.secret(id, "botToken", credentials.BotToken, environment(id, "botToken"))
	if err != nil {
		return err
	}
	raw, err := json.Marshal(wechat.Config{BotID: credentials.BotID, BotToken: ref, APIBaseURL: credentials.APIBaseURL, AllowInsecureLoopback: insecure})
	if err != nil {
		return err
	}
	for index, account := range d.Accounts {
		if account.ID != id {
			continue
		}
		account.Config = raw
		if !slices.Contains(account.AllowedSenders, credentials.UserID) {
			account.AllowedSenders = append(account.AllowedSenders, credentials.UserID)
		}
		d.Accounts[index] = account
		return nil
	}
	d.Accounts = append(d.Accounts, model.AccountConfig{ID: id, Channel: model.WeChat, AllowedSenders: []string{credentials.UserID}, Config: raw})
	return nil
}
