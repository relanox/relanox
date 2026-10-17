package discord

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/coder/websocket"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type gatewayState struct {
	SessionID     string            `json:"sessionId,omitempty"`
	ResumeURL     string            `json:"resumeUrl,omitempty"`
	Sequence      *int64            `json:"sequence"`
	StartedAtMS   int64             `json:"startedAtMs"`
	Anchors       map[string]string `json:"anchors"`
	BoundSinceMS  map[string]int64  `json:"boundSinceMs"`
	Recovering    bool              `json:"recovering,omitempty"`
	RecoveryEpoch string            `json:"recoveryEpoch,omitempty"`
}

// Gateway s is nullable outside Dispatch; zero remains a valid native sequence.
type gatewayFrame struct {
	discordgo.Event
	Sequence *int64 `json:"s"`
}

type gatewayFailure struct {
	reset, fatal bool
	delay        time.Duration
}

func (e *gatewayFailure) Error() string { return "native_gateway_disconnected" }

func gatewayError(err error) error {
	switch websocket.CloseStatus(err) {
	case 4010, 4011, 4012, 4013, 4014:
		return &gatewayFailure{fatal: true}
	case 4007, 4009:
		return &gatewayFailure{reset: true}
	}
	return err
}

func (c *Channel) gatewayKey(bot *identity) string {
	return "gateway:" + string(common.Data([]string{c.config.APIBaseURL, bot.UserID}))
}

func (c *Channel) loop(ctx context.Context) {
	for ctx.Err() == nil {
		bot, err := c.identify(ctx)
		if err == nil {
			err = c.session(ctx, bot)
		}
		if ctx.Err() != nil {
			break
		}
		var native *gatewayFailure
		delay := time.Second
		if errors.As(err, &native) {
			if native.fatal {
				c.host.Connection(model.Degraded, "gateway_fatal_close")
				return
			}
			if native.reset {
				if err = c.requireHistory(ctx, bot); err != nil {
					c.host.Connection(model.Degraded, "history_checkpoint_failed")
				}
			}
			if native.delay > 0 {
				delay = native.delay
			}
		}
		code := "gateway_reconnecting"
		if err != nil && err.Error() == "history_gap_unresolved" {
			code = "history_gap_unresolved"
			delay = 2 * time.Minute
		}
		c.host.Connection(model.Degraded, code)
		if common.Delay(ctx, delay) != nil {
			break
		}
	}
	c.host.Connection(model.Disconnected, "")
}

func (c *Channel) validateGateway(value string) (string, error) {
	u, err := url.Parse(value)
	base, _ := url.Parse(c.config.APIBaseURL)
	if err != nil || u.Scheme != "wss" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", errors.New("invalid_gateway_url")
	}
	regional := strings.HasPrefix(u.Hostname(), "gateway-") && strings.HasSuffix(u.Hostname(), ".discord.gg")
	if u.Hostname() != "gateway.discord.gg" && !regional && u.Hostname() != base.Hostname() {
		return "", errors.New("invalid_gateway_url")
	}
	query := u.Query()
	query.Set("v", "10")
	query.Set("encoding", "json")
	query.Del("compress")
	u.RawQuery = query.Encode()
	return u.String(), nil
}

func (c *Channel) session(ctx context.Context, bot *identity) error {
	state, err := c.initialState(ctx, bot)
	if err != nil {
		return err
	}
	endpoint := state.ResumeURL
	if endpoint == "" {
		var response discordgo.GatewayBotResponse
		if err = c.api(ctx, http.MethodGet, "/gateway/bot", nil, &response); err != nil {
			return err
		}
		endpoint = response.URL
		if response.SessionStartLimit.Total > 0 && response.SessionStartLimit.Remaining <= 0 {
			delay := time.Duration(response.SessionStartLimit.ResetAfter) * time.Millisecond
			return &gatewayFailure{delay: max(time.Second, min(delay, 24*time.Hour))}
		}
	}
	endpoint, err = c.validateGateway(endpoint)
	if err != nil {
		return err
	}
	handshake, cancel := context.WithTimeout(ctx, 30*time.Second)
	socket, _, err := websocket.Dial(handshake, endpoint, &websocket.DialOptions{HTTPClient: c.http})
	cancel()
	if err != nil {
		return err
	}
	defer func() { _ = socket.CloseNow() }()
	socket.SetReadLimit(common.MaxJSONBytes)
	interval, err := gatewayHello(ctx, socket)
	if err != nil {
		return err
	}
	token, err := c.token()
	if err != nil {
		return err
	}
	if err = sendIdentify(ctx, socket, token, state); err != nil {
		return err
	}
	return c.consume(ctx, socket, interval, bot, &state)
}

func gatewayHello(ctx context.Context, socket *websocket.Conn) (time.Duration, error) {
	bounded, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, raw, err := socket.Read(bounded)
	if err != nil {
		return 0, err
	}
	var frame discordgo.Event
	var hello struct {
		Interval int64 `json:"heartbeat_interval"`
	}
	if json.Unmarshal(raw, &frame) != nil || frame.Operation != 10 || json.Unmarshal(frame.RawData, &hello) != nil || hello.Interval <= 0 || hello.Interval > 3600000 {
		return 0, errors.New("invalid_gateway_hello")
	}
	return time.Duration(hello.Interval) * time.Millisecond, nil
}

func sendIdentify(ctx context.Context, socket *websocket.Conn, token string, state gatewayState) error {
	// Current official gateway.mdx uses os/browser/device. discordgo v0.29's
	// IdentifyProperties still serializes obsolete $-prefixed property keys.
	var body any = struct {
		discordgo.Identify
		Properties struct {
			OS      string `json:"os"`
			Browser string `json:"browser"`
			Device  string `json:"device"`
		} `json:"properties"`
	}{Identify: discordgo.Identify{Token: token, Intents: discordgo.IntentsGuildMessages | discordgo.IntentsDirectMessages | discordgo.IntentsMessageContent}, Properties: struct {
		OS      string `json:"os"`
		Browser string `json:"browser"`
		Device  string `json:"device"`
	}{"linux", "relanox", "relanox"}}
	op := 2
	if state.SessionID != "" && state.Sequence != nil {
		op = 6
		body = struct {
			Token     string `json:"token"`
			SessionID string `json:"session_id"`
			Sequence  int64  `json:"seq"`
		}{token, state.SessionID, *state.Sequence}
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

func (r *gatewayReader) heartbeatBody() json.RawMessage {
	var sequence any
	if n := r.received.Load(); n >= 0 {
		sequence = n
	}
	return common.Data(map[string]any{"op": 1, "d": sequence})
}

func (r *gatewayReader) read(ctx context.Context, socket *websocket.Conn) {
	defer r.workers.Done()
	defer close(r.frames)
	for {
		_, raw, err := socket.Read(ctx)
		if err != nil {
			r.failure <- gatewayError(err)
			return
		}
		var frame gatewayFrame
		if json.Unmarshal(raw, &frame) != nil {
			r.failure <- errors.New("invalid_gateway_frame")
			return
		}
		if frame.Operation == 0 && frame.Sequence != nil {
			r.received.Store(*frame.Sequence)
		}
		switch frame.Operation {
		case 11:
			r.ack.Store(true)
			continue
		case 1:
			if err = socket.Write(ctx, websocket.MessageText, r.heartbeatBody()); err != nil {
				r.failure <- err
				return
			}
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
			if err := socket.Write(ctx, websocket.MessageText, r.heartbeatBody()); err != nil {
				_ = socket.CloseNow()
				return
			}
		}
	}
}

func (c *Channel) consume(parent context.Context, socket *websocket.Conn, interval time.Duration, bot *identity, state *gatewayState) error {
	ctx, cancel := context.WithCancel(parent)
	reader := &gatewayReader{frames: make(chan gatewayFrame, 64), failure: make(chan error, 1)}
	reader.received.Store(-1)
	if state.Sequence != nil {
		reader.received.Store(*state.Sequence)
	}
	reader.ack.Store(true)
	reader.workers.Add(2)
	go reader.read(ctx, socket)
	go reader.heartbeat(ctx, socket, interval)
	defer func() { cancel(); _ = socket.CloseNow(); reader.workers.Wait() }()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case frame, ok := <-reader.frames:
			if !ok {
				return <-reader.failure
			}
			if err := c.dispatch(ctx, frame, bot, state); err != nil {
				return err
			}
		}
	}
}

// discordgo v0.29.0 wsapi.go advances its private sequence before calling any
// handler. Persist a separate native sequence only after Core has committed the
// event; heartbeat ACKs and reconnect/resume never skip failed acceptance.
func (c *Channel) dispatch(ctx context.Context, frame gatewayFrame, bot *identity, state *gatewayState) error {
	switch frame.Operation {
	case 7:
		return errors.New("gateway_reconnect_requested")
	case 9:
		var resumable bool
		if json.Unmarshal(frame.RawData, &resumable) != nil || !resumable {
			return &gatewayFailure{reset: true}
		}
		return errors.New("gateway_invalid_session_resumable")
	case 0:
	default:
		return nil
	}
	if frame.Sequence == nil || *frame.Sequence < 0 {
		return errors.New("invalid_gateway_sequence")
	}
	if frame.Type == "READY" {
		if err := c.ready(ctx, frame, bot, state); err != nil {
			return err
		}
	}
	if state.Recovering {
		if err := c.recoverHistory(ctx, bot, state); err != nil {
			return err
		}
	}
	if frame.Type == "MESSAGE_CREATE" {
		if err := c.dispatchMessage(ctx, frame.RawData, bot, state); err != nil {
			return err
		}
	}
	if frame.Type == "READY" || frame.Type == "RESUMED" {
		c.host.Connection(model.Connected, "")
	}
	state.Sequence = frame.Sequence
	if state.SessionID == "" {
		return errors.New("gateway_dispatch_before_ready")
	}
	return common.SaveState(ctx, c.host.State(), c.gatewayKey(bot), state, nil)
}

func (c *Channel) ready(ctx context.Context, frame gatewayFrame, bot *identity, state *gatewayState) error {
	var ready struct {
		discordgo.Ready
		ResumeURL string `json:"resume_gateway_url"`
	}
	if json.Unmarshal(frame.RawData, &ready) != nil || ready.SessionID == "" || ready.User == nil || ready.User.ID != bot.UserID {
		return errors.New("invalid_gateway_identity")
	}
	endpoint, err := c.validateGateway(ready.ResumeURL)
	if err != nil {
		return err
	}
	state.SessionID = ready.SessionID
	state.ResumeURL = endpoint
	state.Sequence = frame.Sequence
	if state.Recovering {
		return common.SaveState(ctx, c.host.State(), c.gatewayKey(bot), state, nil)
	}
	return nil
}
