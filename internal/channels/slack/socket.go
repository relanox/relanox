package slack

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"github.com/slack-go/slack/socketmode"
)

func (c *Channel) loop(ctx context.Context) {
	for ctx.Err() == nil {
		err := c.session(ctx)
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			c.host.Connection(model.Degraded, "native_socket_reconnecting")
		}
		if common.Delay(ctx, time.Second) != nil {
			break
		}
	}
	c.host.Connection(model.Disconnected, "")
}

func (c *Channel) socketURL(value string) (string, error) {
	u, err := url.Parse(value)
	base, _ := url.Parse(c.config.APIBaseURL)
	if err != nil || u.Scheme != "wss" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", errors.New("invalid_socket_url")
	}
	trusted := strings.HasPrefix(u.Hostname(), "wss") && strings.HasSuffix(u.Hostname(), ".slack.com")
	if !trusted && u.Hostname() != base.Hostname() {
		return "", errors.New("invalid_socket_url")
	}
	return u.String(), nil
}

func (c *Channel) session(ctx context.Context) error {
	client, bot, err := c.client(ctx)
	if err != nil {
		return err
	}
	_, endpoint, err := client.StartSocketModeContext(ctx)
	if err != nil {
		return err
	}
	endpoint, err = c.socketURL(endpoint)
	if err != nil {
		return err
	}
	handshake, cancel := context.WithTimeout(ctx, 30*time.Second)
	socket, _, err := websocket.Dial(handshake, endpoint, &websocket.DialOptions{HTTPClient: c.http})
	cancel()
	if err != nil {
		return err
	}
	defer socket.CloseNow()
	socket.SetReadLimit(common.MaxJSONBytes)
	return c.consume(ctx, socket, bot)
}

type socketReader struct {
	requests chan socketmode.Request
	failure  chan error
	workers  sync.WaitGroup
}

// slack-go v0.30.1 socketmode.runMessageReceiver exposes no read-limit option.
// Reuse its native Request/Response models with bounded transport. Reading and
// ping handling continue while media downloads or Core acceptance are pending;
// only successful acceptance sends the native envelope acknowledgement.
func (r *socketReader) read(ctx context.Context, socket *websocket.Conn) {
	defer r.workers.Done()
	defer close(r.requests)
	for {
		_, raw, err := socket.Read(ctx)
		if err != nil {
			r.failure <- err
			return
		}
		var request socketmode.Request
		if json.Unmarshal(raw, &request) != nil {
			r.failure <- errors.New("invalid_socket_request")
			return
		}
		select {
		case r.requests <- request:
		case <-ctx.Done():
			r.failure <- ctx.Err()
			return
		}
	}
}

func (r *socketReader) ping(ctx context.Context, socket *websocket.Conn) {
	defer r.workers.Done()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := socket.Ping(bounded)
			cancel()
			if err != nil {
				socket.CloseNow()
				return
			}
		}
	}
}

func (c *Channel) consume(parent context.Context, socket *websocket.Conn, bot *identity) error {
	ctx, cancel := context.WithCancel(parent)
	reader := &socketReader{requests: make(chan socketmode.Request, 64), failure: make(chan error, 1)}
	reader.workers.Add(2)
	go reader.read(ctx, socket)
	go reader.ping(ctx, socket)
	defer func() { cancel(); socket.CloseNow(); reader.workers.Wait() }()
	hello := false
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case request, ok := <-reader.requests:
			if !ok {
				return <-reader.failure
			}
			if request.Type == "hello" {
				if request.ConnectionInfo.AppID != c.config.AppID {
					return errors.New("socket_app_identity_mismatch")
				}
				hello = true
				c.host.Connection(model.Connected, "")
				continue
			}
			if !hello {
				return errors.New("socket_event_before_hello")
			}
			if err := c.socketRequest(ctx, socket, request, bot); err != nil {
				return err
			}
		}
	}
}

func (c *Channel) socketRequest(ctx context.Context, socket *websocket.Conn, request socketmode.Request, bot *identity) error {
	if request.Type == "disconnect" {
		return errors.New("native_socket_refresh_requested")
	}
	if request.EnvelopeID == "" || len(request.EnvelopeID) > 256 {
		return errors.New("invalid_socket_envelope")
	}
	if request.Type == "events_api" {
		if err := c.receive(ctx, request.Payload, bot); err != nil && !common.PolicyRejection(err) {
			return err
		}
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return socket.Write(bounded, websocket.MessageText, common.Data(socketmode.Response{EnvelopeID: request.EnvelopeID}))
}
