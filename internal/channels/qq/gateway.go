package qq

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type gatewayFrame struct {
	Op       int             `json:"op"`
	Data     json.RawMessage `json:"d"`
	Sequence *int64          `json:"s,omitempty"`
	Type     string          `json:"t,omitempty"`
}
type gatewayState struct {
	SessionID string `json:"sessionId"`
	Sequence  *int64 `json:"sequence"`
}

func (c *Channel) gatewayKey() string { return "gateway:" + string(common.Data(c.identity())) }

type gatewayFailure struct {
	code                  int
	reset, refresh, fatal bool
	delay                 time.Duration
}

func (e *gatewayFailure) Error() string { return "qq_gateway_disconnected" }

// Close codes and IDENTIFY/RESUME follow the official native SDK's gateway
// constants.ts, reconnect.ts and gateway-connection.ts (qqbot-nodejs 1.0.5).
// This implementation persists only the sequence whose input has reached Core;
// the heartbeat may acknowledge a later received sequence without losing replay.
func closeFailure(err error) *gatewayFailure {
	code := int(websocket.CloseStatus(err))
	failure := &gatewayFailure{code: code}
	switch code {
	case 4004:
		failure.refresh = true
	case 4006, 4007, 4009:
		failure.reset = true
		failure.refresh = true
	case 4008:
		failure.delay = time.Minute
	case 4914, 4915:
		failure.fatal = true
	default:
		if code >= 4900 && code <= 4913 {
			failure.reset = true
			failure.refresh = true
		}
	}
	return failure
}

func (c *Channel) connect(ctx context.Context) {
	delays := []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second, time.Minute}
	for attempts := 0; ctx.Err() == nil; {
		ready, err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if ready {
			attempts = 0
		}
		failure := new(gatewayFailure)
		_ = errors.As(err, &failure)
		if failure.refresh {
			c.tokens.Invalidate()
		}
		if failure.reset {
			if err = common.SaveState(ctx, c.host.State(), c.gatewayKey(), gatewayState{}, nil); err != nil {
				c.host.Connection(model.Degraded, "qq_session_state_failed")
				return
			}
		}
		if failure.fatal {
			c.host.Connection(model.Degraded, "qq_gateway_fatal_close")
			return
		}
		if attempts >= 20 {
			c.host.Connection(model.Degraded, "qq_gateway_retry_exhausted")
			return
		}
		c.host.Connection(model.Degraded, "qq_reconnecting")
		delay := failure.delay
		if delay == 0 {
			delay = delays[min(attempts, len(delays)-1)]
		}
		attempts++
		if common.Delay(ctx, delay) != nil {
			return
		}
	}
}

func (c *Channel) gatewayURL(ctx context.Context) (string, error) {
	var response struct {
		URL string `json:"url"`
	}
	if err := c.api(ctx, http.MethodGet, "/gateway", nil, &response); err != nil {
		return "", err
	}
	u, err := url.Parse(response.URL)
	if err != nil || u.Scheme != "wss" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", errors.New("invalid_qq_gateway_url")
	}
	return response.URL, nil
}

func gatewayHello(ctx context.Context, socket *websocket.Conn) (time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, raw, err := socket.Read(ctx)
	if err != nil {
		return 0, err
	}
	var frame gatewayFrame
	var hello struct {
		Interval int64 `json:"heartbeat_interval"`
	}
	if json.Unmarshal(raw, &frame) != nil || frame.Op != 10 || json.Unmarshal(frame.Data, &hello) != nil || hello.Interval <= 0 || hello.Interval > 3600000 {
		return 0, errors.New("invalid_qq_gateway_hello")
	}
	return time.Duration(hello.Interval) * time.Millisecond, nil
}

func identify(ctx context.Context, socket *websocket.Conn, state gatewayState, token string) error {
	body := map[string]any{"token": "QQBot " + token, "intents": 1 << 25, "shard": []int{0, 1}}
	op := 2
	if state.SessionID != "" && state.Sequence != nil {
		op = 6
		body = map[string]any{"token": "QQBot " + token, "session_id": state.SessionID, "seq": *state.Sequence}
	}
	return socket.Write(ctx, websocket.MessageText, common.Data(map[string]any{"op": op, "d": body}))
}

type gatewayReader struct {
	frames   chan gatewayFrame
	failure  chan error
	received atomic.Int64
	ack      atomic.Bool
	workers  sync.WaitGroup
}

func newGatewayReader(state gatewayState) *gatewayReader {
	r := &gatewayReader{frames: make(chan gatewayFrame, 64), failure: make(chan error, 1)}
	r.received.Store(-1)
	r.ack.Store(true)
	if state.Sequence != nil {
		r.received.Store(*state.Sequence)
	}
	return r
}

func (r *gatewayReader) sequence() any {
	value := r.received.Load()
	if value < 0 {
		return nil
	}
	return value
}

func (r *gatewayReader) read(ctx context.Context, socket *websocket.Conn) {
	defer r.workers.Done()
	defer close(r.frames)
	for {
		_, raw, err := socket.Read(ctx)
		if err != nil {
			r.failure <- closeFailure(err)
			return
		}
		var frame gatewayFrame
		if json.Unmarshal(raw, &frame) != nil {
			r.failure <- errors.New("invalid_qq_gateway_frame")
			return
		}
		if frame.Sequence != nil {
			r.received.Store(*frame.Sequence)
		}
		if frame.Op == 11 {
			r.ack.Store(true)
			continue
		}
		select {
		case r.frames <- frame:
		case <-ctx.Done():
			r.failure <- ctx.Err()
			return
		}
	}
}

func (r *gatewayReader) heartbeat(ctx context.Context, socket *websocket.Conn, interval time.Duration) {
	defer r.workers.Done()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !r.ack.Swap(false) {
				_ = socket.CloseNow()
				return
			}
			if err := socket.Write(ctx, websocket.MessageText, common.Data(map[string]any{"op": 1, "d": r.sequence()})); err != nil {
				_ = socket.CloseNow()
				return
			}
		}
	}
}

func (c *Channel) session(ctx context.Context) (bool, error) {
	state, _, err := common.ReadState[gatewayState](ctx, c.host.State(), c.gatewayKey())
	if err != nil {
		return false, err
	}
	endpoint, err := c.gatewayURL(ctx)
	if err != nil {
		return false, err
	}
	token, err := c.token(ctx)
	if err != nil {
		return false, err
	}
	handshake, cancel := context.WithTimeout(ctx, 30*time.Second)
	socket, _, err := websocket.Dial(handshake, endpoint, &websocket.DialOptions{HTTPClient: common.HTTPClient(c.options.HTTPClient)})
	cancel()
	if err != nil {
		return false, err
	}
	defer func() { _ = socket.CloseNow() }()
	socket.SetReadLimit(1024 * 1024)
	interval, err := gatewayHello(ctx, socket)
	if err != nil {
		return false, err
	}
	if err = identify(ctx, socket, state, token); err != nil {
		return false, err
	}
	return c.consumeSession(ctx, socket, interval, &state)
}

func (c *Channel) consumeSession(parent context.Context, socket *websocket.Conn, interval time.Duration, state *gatewayState) (bool, error) {
	ctx, cancel := context.WithCancel(parent)
	reader := newGatewayReader(*state)
	reader.workers.Add(2)
	go reader.read(ctx, socket)
	go reader.heartbeat(ctx, socket, interval)
	defer func() { cancel(); _ = socket.CloseNow(); reader.workers.Wait() }()
	ready := false
	for {
		select {
		case <-ctx.Done():
			return ready, ctx.Err()
		case frame, ok := <-reader.frames:
			if !ok {
				return ready, <-reader.failure
			}
			connected, err := c.dispatch(ctx, socket, frame, state, reader.sequence())
			ready = ready || connected
			if err != nil {
				return ready, err
			}
		}
	}
}

func (c *Channel) dispatch(ctx context.Context, socket *websocket.Conn, frame gatewayFrame, state *gatewayState, received any) (bool, error) {
	switch frame.Op {
	case 1:
		return false, socket.Write(ctx, websocket.MessageText, common.Data(map[string]any{"op": 1, "d": received}))
	case 7:
		return false, &gatewayFailure{}
	case 9:
		var resumable bool
		if json.Unmarshal(frame.Data, &resumable) != nil {
			resumable = false
		}
		return false, &gatewayFailure{reset: !resumable, refresh: !resumable, delay: 3 * time.Second}
	case 0:
		return c.dispatchEvent(ctx, frame, state)
	}
	return false, nil
}

func (c *Channel) dispatchEvent(ctx context.Context, frame gatewayFrame, state *gatewayState) (bool, error) {
	connected := false
	switch frame.Type {
	case "READY":
		var ready struct {
			SessionID string `json:"session_id"`
		}
		if json.Unmarshal(frame.Data, &ready) != nil || !validID(ready.SessionID) {
			return false, errors.New("invalid_qq_gateway_session")
		}
		state.SessionID = ready.SessionID
		connected = true
	case "RESUMED":
		connected = true
	case "C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE":
		if err := c.receive(ctx, frame); err != nil {
			return false, err
		}
	}
	if frame.Sequence != nil {
		state.Sequence = frame.Sequence
	}
	if state.SessionID != "" {
		if err := common.SaveState(ctx, c.host.State(), c.gatewayKey(), state, nil); err != nil {
			return false, err
		}
	}
	if connected {
		c.host.Connection(model.Connected, "")
	}
	return connected, nil
}
