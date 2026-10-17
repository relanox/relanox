package irc

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	wire "gopkg.in/irc.v4"
)

type connection struct {
	socket                net.Conn
	gate                  chan struct{}
	mu                    sync.RWMutex
	state                 sessionState
	offered               map[string]string
	saslStarted, saslDone bool
}

func (c *connection) snapshot() sessionState { c.mu.RLock(); defer c.mu.RUnlock(); return c.state }

func (c *connection) write(ctx context.Context, message *wire.Message) (bool, error) {
	line := message.String()
	if err := validWire(line); err != nil {
		return false, err
	}
	select {
	case c.gate <- struct{}{}:
	case <-ctx.Done():
		return false, ctx.Err()
	}
	defer func() { <-c.gate }()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	deadline := time.Now().Add(10 * time.Second)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	if err := c.socket.SetWriteDeadline(deadline); err != nil {
		return false, err
	}
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { defer close(done); _ = c.socket.SetWriteDeadline(time.Now()) })
	defer func() {
		if !stop() {
			<-done
		}
		_ = c.socket.SetWriteDeadline(time.Time{})
	}()
	return true, wire.NewWriter(c.socket).WriteMessage(message)
}

func validWire(line string) error {
	command := line
	if strings.HasPrefix(line, "@") {
		space := strings.IndexByte(line, ' ')
		if space < 0 || space+1 > 4096 {
			return errors.New("invalid_irc_tags")
		}
		command = line[space+1:]
	}
	if strings.ContainsAny(line, "\x00\r\n") || len(command)+2 > 512 {
		return errors.New("invalid_irc_line")
	}
	return nil
}

func (c *Channel) loop(ctx context.Context) {
	for ctx.Err() == nil {
		if err := c.connect(ctx); err != nil && ctx.Err() == nil {
			c.host.Connection(model.Degraded, "native_connection_failed")
		}
		if common.Delay(ctx, time.Second) != nil {
			break
		}
	}
	c.host.Connection(model.Disconnected, "")
}

// irc.Client sends CAP END from its internal CAP ACK filter before calling the
// user handler, without waiting for SASL authentication. Keep registration and
// bounded I/O here so SASL completes before CAP END; parsing and serialization
// still use the SDK's Message and Writer implementations.
func (c *Channel) connect(ctx context.Context) error {
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	var socket net.Conn
	var err error
	if *c.config.TLS {
		cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: c.config.Server}
		if c.options.TLSClientConfig != nil {
			cfg = c.options.TLSClientConfig.Clone()
			cfg.ServerName = c.config.Server
			if cfg.MinVersion < tls.VersionTLS12 {
				cfg.MinVersion = tls.VersionTLS12
			}
		}
		socket, err = (&tls.Dialer{NetDialer: dialer, Config: cfg}).DialContext(ctx, "tcp", c.address())
	} else {
		socket, err = dialer.DialContext(ctx, "tcp", c.address())
	}
	if err != nil {
		return err
	}
	defer socket.Close()
	stop := context.AfterFunc(ctx, func() { socket.Close() })
	defer stop()
	current := &connection{socket: socket, gate: make(chan struct{}, 1), state: sessionState{Nick: c.config.Nick, CaseMapping: "rfc1459", HostLength: 253}, offered: make(map[string]string)}
	c.mu.Lock()
	c.current = current
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.current == current {
			c.current = nil
		}
		c.mu.Unlock()
		c.host.Connection(model.Disconnected, "")
	}()
	if err = c.register(ctx, current); err != nil {
		return err
	}
	scanner := bufio.NewScanner(socket)
	scanner.Buffer(make([]byte, 4096), 16*1024)
	_ = socket.SetReadDeadline(time.Now().Add(15 * time.Second))
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			continue
		}
		if strings.ContainsAny(line, "\x00\r\n") {
			return errors.New("invalid_native_irc_line")
		}
		message, err := wire.ParseMessage(line)
		if err != nil {
			return errors.New("invalid_native_irc_message")
		}
		if err = c.handle(ctx, current, message); err != nil {
			return err
		}
		timeout := 15 * time.Second
		if current.snapshot().Ready {
			timeout = 120 * time.Second
		}
		_ = socket.SetReadDeadline(time.Now().Add(timeout))
	}
	return scanner.Err()
}

func (c *Channel) register(ctx context.Context, current *connection) error {
	if c.config.Password != nil {
		secret, err := c.secret(*c.config.Password)
		if err != nil {
			return err
		}
		if _, err = current.write(ctx, &wire.Message{Command: "PASS", Params: []string{secret}}); err != nil {
			return err
		}
	}
	for _, message := range []*wire.Message{{Command: "CAP", Params: []string{"LS", "302"}}, {Command: "NICK", Params: []string{c.config.Nick}}, {Command: "USER", Params: []string{c.config.Nick, "0", "*", "Relanox"}}} {
		if _, err := current.write(ctx, message); err != nil {
			return err
		}
	}
	return nil
}

func (c *Channel) secret(ref model.SecretRef) (string, error) {
	value, err := c.options.Secret(ref)
	if err != nil {
		return "", err
	}
	if value == "" || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New("invalid_irc_secret")
	}
	return value, nil
}
