package irc

import (
	"context"
	"encoding/base64"
	"errors"
	"slices"
	"strconv"
	"strings"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	wire "gopkg.in/irc.v4"
)

func (c *Channel) handle(ctx context.Context, current *connection, message *wire.Message) error {
	if slices.Contains([]string{"902", "904", "905", "906", "907", "433", "ERROR"}, message.Command) {
		return errors.New("irc_registration_failed")
	}
	switch message.Command {
	case "PING":
		if len(message.Params) > 0 {
			_, err := current.write(ctx, &wire.Message{Command: "PONG", Params: []string{message.Trailing()}})
			return err
		}
	case "CAP":
		return c.negotiate(ctx, current, message)
	case "AUTHENTICATE":
		if len(message.Params) > 0 && message.Params[0] == "+" {
			return c.authenticate(ctx, current)
		}
	case "903":
		current.saslDone = true
		_, err := current.write(ctx, &wire.Message{Command: "CAP", Params: []string{"END"}})
		return err
	case "001":
		return c.welcome(ctx, current, message)
	case "005":
		return current.support(message)
	case "NICK":
		current.mu.Lock()
		defer current.mu.Unlock()
		if message.Prefix != nil && fold(message.Prefix.Name, current.state.CaseMapping) == fold(current.state.Nick, current.state.CaseMapping) && len(message.Params) > 0 {
			if !nickname(message.Params[0]) {
				return errors.New("invalid_native_nick")
			}
			current.state.Nick = message.Params[0]
		}
	case "PRIVMSG":
		return c.receive(ctx, current, message)
	}
	return nil
}

func (c *Channel) welcome(ctx context.Context, current *connection, message *wire.Message) error {
	if c.config.SASL != nil && !current.saslDone {
		return errors.New("sasl_incomplete")
	}
	if len(message.Params) == 0 || !nickname(message.Params[0]) {
		return errors.New("invalid_native_nick")
	}
	current.mu.Lock()
	current.state.Nick = message.Params[0]
	current.state.Ready = true
	current.mu.Unlock()
	for _, channel := range c.channels {
		if _, err := current.write(ctx, &wire.Message{Command: "JOIN", Params: []string{channel}}); err != nil {
			return err
		}
	}
	c.host.Connection(model.Connected, "")
	return nil
}

func (c *Channel) negotiate(ctx context.Context, current *connection, message *wire.Message) error {
	if len(message.Params) < 3 {
		return errors.New("invalid_cap_reply")
	}
	subcommand := message.Params[1]
	capabilities := strings.Fields(message.Trailing())
	switch subcommand {
	case "LS":
		for _, capability := range capabilities {
			key, value, _ := strings.Cut(capability, "=")
			current.offered[key] = value
		}
		if len(message.Params) > 3 && message.Params[2] == "*" {
			return nil
		}
		return c.requestCapabilities(ctx, current)
	case "ACK":
		current.acknowledge(capabilities)
		if c.config.SASL != nil {
			if !slices.Contains(capabilities, "sasl") {
				return errors.New("sasl_unavailable")
			}
			current.saslStarted = true
			_, err := current.write(ctx, &wire.Message{Command: "AUTHENTICATE", Params: []string{"PLAIN"}})
			return err
		}
		_, err := current.write(ctx, &wire.Message{Command: "CAP", Params: []string{"END"}})
		return err
	case "NAK":
		if c.config.SASL != nil || !c.config.AllowNickFallback {
			return errors.New("required_capability_rejected")
		}
		_, err := current.write(ctx, &wire.Message{Command: "CAP", Params: []string{"END"}})
		return err
	case "DEL":
		current.mu.Lock()
		defer current.mu.Unlock()
		for _, capability := range capabilities {
			if capability == "message-tags" {
				current.state.MessageTags = false
			}
			if capability == "account-tag" {
				current.state.AccountTags = false
			}
		}
	}
	return nil
}

func (c *connection) acknowledge(capabilities []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, capability := range capabilities {
		switch capability {
		case "message-tags":
			c.state.MessageTags = true
		case "-message-tags":
			c.state.MessageTags = false
		case "account-tag":
			c.state.AccountTags = true
		case "-account-tag":
			c.state.AccountTags = false
		}
	}
}

func (c *Channel) requestCapabilities(ctx context.Context, current *connection) error {
	if _, ok := current.offered["account-tag"]; !ok && !c.config.AllowNickFallback {
		return errors.New("account_identity_unavailable")
	}
	if c.config.SASL != nil {
		mechanisms, ok := current.offered["sasl"]
		if !ok || mechanisms != "" && !slices.Contains(strings.Split(mechanisms, ","), "PLAIN") {
			return errors.New("sasl_unavailable")
		}
	}
	var requested []string
	for _, capability := range []string{"account-tag", "server-time", "message-tags"} {
		if _, ok := current.offered[capability]; ok {
			requested = append(requested, capability)
		}
	}
	if c.config.SASL != nil {
		requested = append(requested, "sasl")
	}
	params := []string{"END"}
	if len(requested) > 0 {
		params = []string{"REQ", strings.Join(requested, " ")}
	}
	_, err := current.write(ctx, &wire.Message{Command: "CAP", Params: params})
	return err
}

func (c *Channel) authenticate(ctx context.Context, current *connection) error {
	if c.config.SASL == nil || !current.saslStarted {
		return errors.New("unexpected_sasl_challenge")
	}
	secret, err := c.secret(c.config.SASL.Password)
	if err != nil {
		return err
	}
	payload := base64.StdEncoding.EncodeToString([]byte("\x00" + c.config.SASL.Username + "\x00" + secret))
	if len(payload) > 4096 {
		return errors.New("sasl_secret_too_large")
	}
	for offset := 0; offset < len(payload); offset += 400 {
		if _, err = current.write(ctx, &wire.Message{Command: "AUTHENTICATE", Params: []string{payload[offset:min(offset+400, len(payload))]}}); err != nil {
			return err
		}
	}
	if len(payload)%400 == 0 {
		_, err = current.write(ctx, &wire.Message{Command: "AUTHENTICATE", Params: []string{"+"}})
	}
	return err
}

func (c *connection) support(message *wire.Message) error {
	if len(message.Params) < 2 {
		return errors.New("invalid_isupport")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, parameter := range message.Params[1 : len(message.Params)-1] {
		switch parameter {
		case "-HOSTLEN":
			c.state.HostLength = 253
			continue
		case "-USERLEN":
			c.state.UserLength = 0
			continue
		case "-CASEMAPPING":
			c.state.CaseMapping = "rfc1459"
			continue
		}
		key, value, ok := strings.Cut(parameter, "=")
		if !ok {
			continue
		}
		if key == "CASEMAPPING" {
			if !slices.Contains([]string{"ascii", "rfc1459", "strict-rfc1459"}, value) {
				return errors.New("unsupported_casemapping")
			}
			c.state.CaseMapping = value
			continue
		}
		if key == "HOSTLEN" || key == "USERLEN" {
			length, err := strconv.Atoi(value)
			if err != nil || length < 1 || length > 512 {
				return errors.New("invalid_isupport_length")
			}
			if key == "HOSTLEN" {
				c.state.HostLength = length
			} else {
				c.state.UserLength = length
			}
		}
	}
	return nil
}

func markdown(value string) (string, error) {
	var out strings.Builder
	for _, run := range text.Runs(value) {
		for _, r := range run.Text {
			if (r < 32 && r != '\r' && r != '\n' && r != '\t') || r == 127 {
				return "", errors.New("invalid_irc_control")
			}
		}
		content := strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ", "\t", " ").Replace(run.Text)
		toggles := ""
		if run.Code || run.Pre {
			toggles = "\x11"
		} else {
			if run.Bold {
				toggles += "\x02"
			}
			if run.Italic {
				toggles += "\x1d"
			}
			if run.Strike {
				toggles += "\x1e"
			}
		}
		if toggles != "" {
			content = toggles + content + "\x0f"
		}
		out.WriteString(content)
		if run.Href != "" && run.Href != run.Text {
			out.WriteString(" (" + run.Href + ")")
		}
	}
	return out.String(), nil
}
