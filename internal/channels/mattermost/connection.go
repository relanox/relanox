package mattermost

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strconv"
	"time"

	mm "github.com/mattermost/mattermost/server/public/model"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type cursor struct {
	Identity      targetData       `json:"identity"`
	ConnectionID  string           `json:"connectionId"`
	NextSequence  int64            `json:"nextSequence"`
	StartedAtMS   int64            `json:"startedAtMs"`
	Watermarks    map[string]int64 `json:"watermarks,omitempty"`
	BoundStarts   map[string]int64 `json:"boundStarts,omitempty"`
	Recovery      *historyRecovery `json:"recovery,omitempty"`
	RecoveryEpoch string           `json:"recoveryEpoch,omitempty"`
}

// Mattermost's server sequence is independent of client action seq/seq_reply.
// https://github.com/mattermost/mattermost/blob/master/webapp/platform/client/src/websocket.ts
// https://github.com/mattermost/mattermost/blob/master/server/public/model/websocket_client.go
type frame struct {
	Event         string `json:"event"`
	Sequence      *int64 `json:"seq"`
	ReplySequence int64  `json:"seq_reply"`
	Status        string `json:"status"`
	Data          struct {
		Post         string `json:"post"`
		ConnectionID string `json:"connection_id"`
	} `json:"data"`
}

func (c *Channel) run(ctx context.Context) {
	defer c.host.Connection(model.Disconnected, "")
	delay := time.Second
	for ctx.Err() == nil {
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			code := "connection_failed"
			if errors.Is(err, errHistoryIncomplete) || errors.Is(err, errHistoryUnavailable) {
				code = err.Error()
			}
			c.host.Connection(model.Degraded, code)
		}
		if common.Delay(ctx, delay) != nil {
			return
		}
		delay = min(30*time.Second, delay*2)
	}
}

func (c *Channel) session(ctx context.Context) error {
	identity, token, err := c.credentials(ctx)
	if err != nil {
		return err
	}
	saved, _, err := common.ReadState[cursor](ctx, c.host.State(), "websocket-cursor")
	if err != nil {
		return err
	}
	if saved.Identity != identity {
		saved = cursor{Identity: identity}
	}
	if c.config.RecoveryEpoch != "" && saved.RecoveryEpoch != c.config.RecoveryEpoch {
		saved = cursor{Identity: identity, StartedAtMS: time.Now().UnixMilli(), RecoveryEpoch: c.config.RecoveryEpoch}
		if err = common.SaveState(ctx, c.host.State(), "websocket-cursor", saved, nil); err != nil {
			return err
		}
	}
	if saved.StartedAtMS == 0 {
		saved.StartedAtMS = time.Now().UnixMilli()
	}
	c.prepareBoundStarts(&saved)
	if err = common.SaveState(ctx, c.host.State(), "websocket-cursor", saved, nil); err != nil {
		return err
	}
	endpoint, _ := url.Parse(c.config.ServerURL + "/api/v4/websocket")
	if endpoint.Scheme == "https" {
		endpoint.Scheme = "wss"
	} else {
		endpoint.Scheme = "ws"
	}
	query := endpoint.Query()
	query.Set("connection_id", saved.ConnectionID)
	query.Set("sequence_number", strconv.FormatInt(saved.NextSequence, 10))
	endpoint.RawQuery = query.Encode()
	connection, _, err := websocket.Dial(ctx, endpoint.String(), &websocket.DialOptions{HTTPClient: c.client, HTTPHeader: bearer(token)})
	if err != nil {
		return err
	}
	defer func() { _ = connection.CloseNow() }()
	connection.SetReadLimit(4 << 20)
	lifetime, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(lifetime, func() { _ = connection.CloseNow() })
	defer stop()
	if err = wsjson.Write(lifetime, connection, struct {
		Seq    int    `json:"seq"`
		Action string `json:"action"`
		Data   struct {
			Token string `json:"token"`
		} `json:"data"`
	}{Seq: 1, Action: "authentication_challenge", Data: struct {
		Token string `json:"token"`
	}{Token: token}}); err != nil {
		return err
	}
	pingDone := make(chan struct{})
	go func() { defer close(pingDone); c.ping(lifetime, connection); cancel() }()
	defer func() { cancel(); <-pingDone }()
	return c.readFrames(lifetime, connection, &saved)
}

func (c *Channel) prepareBoundStarts(saved *cursor) {
	bound := c.host.BoundChatIDs()
	for id := range saved.Watermarks {
		if !slices.Contains(bound, id) {
			delete(saved.Watermarks, id)
		}
	}
	for id := range saved.BoundStarts {
		if !slices.Contains(bound, id) {
			delete(saved.BoundStarts, id)
		}
	}
	if saved.BoundStarts == nil {
		saved.BoundStarts = map[string]int64{}
	}
	for _, id := range bound {
		if saved.BoundStarts[id] != 0 {
			continue
		}
		started := saved.Watermarks[id]
		if started == 0 {
			started = time.Now().UnixMilli()
		}
		saved.BoundStarts[id] = started
	}
}

func (c *Channel) ping(ctx context.Context, connection *websocket.Conn) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probe, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := connection.Ping(probe)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// The SDK WebSocketEvent decoder collapses an omitted seq into zero, and its
// Listen loop blocks on full event channels without a context-aware shutdown.
// Keep the bounded decoder here so an absent sequence cannot advance durable
// state and Close can join all workers. REST operations use the SDK client.
func (c *Channel) readFrames(ctx context.Context, connection *websocket.Conn, saved *cursor) error {
	// A reliable reconnect can replay the retained queue without a new hello.
	// The upgrade is authenticated by the checked current-user token header.
	authenticated := saved.ConnectionID != ""
	for ctx.Err() == nil {
		var input frame
		if err := wsjson.Read(ctx, connection, &input); err != nil {
			return err
		}
		if input.ReplySequence != 0 {
			if input.ReplySequence == 1 && input.Status != "OK" {
				c.identities.Invalidate()
				return errors.New("native_authentication_failed")
			}
			if input.ReplySequence == 1 && authenticated {
				c.host.Connection(model.Connected, "")
			}
			continue
		}
		if input.Event == "hello" {
			authenticated = true
		}
		if !authenticated {
			return errors.New("native_hello_required")
		}
		if err := c.processFrame(ctx, input, saved); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func (c *Channel) processFrame(ctx context.Context, input frame, saved *cursor) error {
	if input.Sequence == nil || *input.Sequence < 0 {
		return errors.New("invalid_native_sequence")
	}
	if input.Event == "hello" {
		if input.Data.ConnectionID == "" || len(input.Data.ConnectionID) > 256 {
			return errors.New("invalid_native_connection")
		}
		if input.Data.ConnectionID != saved.ConnectionID {
			if saved.ConnectionID != "" {
				c.host.Connection(model.Degraded, "history_gap")
				c.host.Observer().Log(ctx, "warn", "operation.failed", model.LogFields{Component: "channel:mattermost", Operation: "recovery", ErrorCode: "history_gap"})
				if err := c.recoverHistory(ctx, saved); err != nil {
					return err
				}
			}
			saved.ConnectionID = input.Data.ConnectionID
			saved.NextSequence = 0
		}
	}
	if *input.Sequence != saved.NextSequence {
		return errors.New("native_sequence_mismatch")
	}
	if input.Event == "posted" {
		var post mm.Post
		if json.Unmarshal([]byte(input.Data.Post), &post) != nil {
			return errors.New("invalid_native_post")
		}
		if err := c.receivePosted(ctx, &post, saved); err != nil {
			return err
		}
	}
	// Advance only after durable acceptance. A crash between accept and this CAS
	// replays the native event, which Core deduplicates using the immutable post ID.
	saved.NextSequence = *input.Sequence + 1
	if err := common.SaveState(ctx, c.host.State(), "websocket-cursor", saved, nil); err != nil {
		return err
	}
	if input.Event == "hello" {
		c.host.Connection(model.Connected, "")
	}
	return nil
}

func (c *Channel) receivePosted(ctx context.Context, post *mm.Post, saved *cursor) error {
	if !validPost(post) {
		return errors.New("invalid_native_post")
	}
	// Reliable native replay can contain events preceding a new binding. They
	// still consume socket sequence numbers, without becoming new Core work.
	if post.CreateAt < saved.BoundStarts[post.ChannelId] {
		return nil
	}
	if err := c.receive(ctx, post, saved.Identity); err != nil {
		return err
	}
	if slices.Contains(c.host.BoundChatIDs(), post.ChannelId) {
		if saved.Watermarks == nil {
			saved.Watermarks = map[string]int64{}
		}
		saved.Watermarks[post.ChannelId] = max(saved.Watermarks[post.ChannelId], post.CreateAt)
	}
	return nil
}
