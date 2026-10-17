package wecom

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// Native frame and upload fields verified against @wecom/aibot-node-sdk 1.0.7
// WsConnectionManager and WSClient.uploadMedia (MIT).
// https://github.com/WecomTeam/aibot-node-sdk
type frame struct {
	Command string `json:"cmd,omitempty"`
	Headers struct {
		RequestID string `json:"req_id"`
	} `json:"headers"`
	Body      json.RawMessage `json:"body,omitempty"`
	ErrorCode *int            `json:"errcode,omitempty"`
}

type socketSession struct {
	conn    *websocket.Conn
	done    chan struct{}
	mu      sync.Mutex
	pending map[string]chan frame
	callMu  sync.Mutex
}

type nativeError struct{ code int }

func (e *nativeError) Error() string { return "wecom_native_error" }

func (s *socketSession) call(ctx context.Context, command, id string, body any) (frame, error) {
	s.callMu.Lock()
	defer s.callMu.Unlock()
	var result frame
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if id == "" {
		id = command + "_" + common.RandomID()
	}
	result.Headers.RequestID = id
	result.Command = command
	result.Body = common.Data(body)
	response := make(chan frame, 1)
	s.mu.Lock()
	s.pending[id] = response
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.pending, id); s.mu.Unlock() }()
	if err := s.conn.Write(ctx, websocket.MessageText, common.Data(result)); err != nil {
		return frame{}, err
	}
	select {
	case result = <-response:
		if result.ErrorCode == nil {
			return frame{}, errors.New("wecom_missing_ack_code")
		}
		if *result.ErrorCode != 0 {
			return frame{}, &nativeError{code: *result.ErrorCode}
		}
		return result, nil
	case <-ctx.Done():
		return frame{}, ctx.Err()
	case <-s.done:
		return frame{}, errors.New("wecom_socket_closed")
	}
}

func (s *socketSession) read(ctx context.Context, callbacks chan<- frame) error {
	defer close(s.done)
	for {
		_, raw, err := s.conn.Read(ctx)
		if err != nil {
			return err
		}
		var message frame
		if json.Unmarshal(raw, &message) != nil || message.Headers.RequestID == "" {
			continue
		}
		if message.Command == "aibot_msg_callback" || message.Command == "aibot_event_callback" {
			select {
			case callbacks <- message:
			case <-ctx.Done():
				return ctx.Err()
			}
			continue
		}
		s.mu.Lock()
		pending := s.pending[message.Headers.RequestID]
		s.mu.Unlock()
		if pending != nil {
			select {
			case pending <- message:
			default:
			}
		}
	}
}

func (s *socketSession) upload(ctx context.Context, media model.StoredMedia) (string, error) {
	const chunkSize = 512 * 1024
	count := (len(media.Data) + chunkSize - 1) / chunkSize
	if count == 0 || count > 100 {
		return "", errors.New("media_protocol_limit")
	}
	kind := string(media.Reference.Kind)
	if kind == "audio" {
		kind = "voice"
	}
	digest := md5.Sum(media.Data)
	init, err := s.call(ctx, "aibot_upload_media_init", "", map[string]any{"type": kind, "filename": media.Reference.FileName, "total_size": len(media.Data), "total_chunks": count, "md5": hex.EncodeToString(digest[:])})
	if err != nil {
		return "", err
	}
	var ticket struct {
		UploadID string `json:"upload_id"`
	}
	if json.Unmarshal(init.Body, &ticket) != nil || ticket.UploadID == "" {
		return "", errors.New("missing_upload_id")
	}
	for index := 0; index < count; index++ {
		end := min(len(media.Data), (index+1)*chunkSize)
		body := map[string]any{"upload_id": ticket.UploadID, "chunk_index": index, "base64_data": base64.StdEncoding.EncodeToString(media.Data[index*chunkSize : end])}
		// Chunk uploads are preparatory and safe to replay; message sends are not.
		for attempt := 0; attempt < 3; attempt++ {
			_, err = s.call(ctx, "aibot_upload_media_chunk", "", body)
			if err == nil {
				break
			}
			if attempt < 2 {
				if err = common.Delay(ctx, time.Duration(attempt+1)*500*time.Millisecond); err != nil {
					return "", err
				}
			}
		}
		if err != nil {
			return "", err
		}
	}
	final, err := s.call(ctx, "aibot_upload_media_finish", "", map[string]string{"upload_id": ticket.UploadID})
	if err != nil {
		return "", err
	}
	var receipt struct {
		MediaID string `json:"media_id"`
	}
	if json.Unmarshal(final.Body, &receipt) != nil || receipt.MediaID == "" {
		return "", errors.New("missing_media_id")
	}
	return receipt.MediaID, nil
}

var errReplaced = errors.New("wecom_connection_replaced")

func (c *Channel) socket(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, websocketURL, &websocket.DialOptions{HTTPClient: common.HTTPClient(c.options.HTTPClient)})
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1024 * 1024)
	session := &socketSession{conn: conn, done: make(chan struct{}), pending: make(map[string]chan frame)}
	callbacks := make(chan frame, 128)
	readError := make(chan error, 1)
	go func() { readError <- session.read(ctx, callbacks) }()
	secret, err := c.options.Secret(c.config.Secret)
	if err != nil {
		return err
	}
	if _, err = session.call(ctx, "aibot_subscribe", "", map[string]string{"bot_id": c.config.BotID, "secret": secret}); err != nil {
		return err
	}
	c.mu.Lock()
	c.active = session
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.active == session {
			c.active = nil
		}
		c.mu.Unlock()
	}()
	c.host.Connection(model.Connected, "")
	var workers sync.WaitGroup
	workQueue := make(chan frame, 128)
	for range 4 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case message := <-workQueue:
					if err := c.receiveSocket(ctx, message); err != nil && ctx.Err() == nil {
						c.host.Connection(model.Degraded, "ingest_failed")
					}
				}
			}
		}()
	}
	defer func() { cancel(); conn.CloseNow(); workers.Wait() }()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readError:
			return err
		case <-ticker.C:
			if _, err = session.call(ctx, "ping", "", map[string]any{}); err != nil {
				return err
			}
		case message := <-callbacks:
			if message.Command == "aibot_event_callback" {
				var event struct {
					Event struct {
						Type string `json:"eventtype"`
					} `json:"event"`
				}
				if json.Unmarshal(message.Body, &event) == nil && event.Event.Type == "disconnected_event" {
					cancel()
					return errReplaced
				}
				continue
			}
			select {
			case workQueue <- message:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}

func (c *Channel) connect(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := c.socket(ctx)
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, errReplaced) {
			c.host.Connection(model.Degraded, "bot_connection_replaced")
			return
		}
		c.host.Connection(model.Degraded, "wecom_reconnecting")
		if common.Delay(ctx, backoff) != nil {
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func socketFailure(err error, preparing bool) model.SendResult {
	var native *nativeError
	if errors.As(err, &native) {
		if native.code == -1 || native.code == 45009 {
			return common.Retry("wecom_rate_limited", time.Second)
		}
		return common.Reject("wecom_request_rejected")
	}
	if err.Error() == "media_protocol_limit" {
		return common.Reject("media_protocol_limit")
	}
	return common.Failure(err, preparing)
}
