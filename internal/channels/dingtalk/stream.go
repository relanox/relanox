package dingtalk

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/coder/websocket"
	dingpayload "github.com/open-dingtalk/dingtalk-stream-sdk-go/payload"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type nativeMessage struct {
	ID               string         `json:"msgId"`
	ConversationType string         `json:"conversationType"`
	ConversationID   string         `json:"conversationId"`
	SenderID         string         `json:"senderId"`
	StaffID          string         `json:"senderStaffId,omitempty"`
	BotUserID        string         `json:"chatbotUserId,omitempty"`
	RobotCode        string         `json:"robotCode"`
	Mentioned        bool           `json:"isInAtList,omitempty"`
	Type             string         `json:"msgtype"`
	Content          *nativeContent `json:"content,omitempty"`
	Text             *struct {
		Content string `json:"content"`
	} `json:"text,omitempty"`
}

type streamFrame = dingpayload.DataFrame

func acknowledge(ctx context.Context, socket *websocket.Conn, frame streamFrame, system bool) error {
	headers, data := map[string]string{"contentType": "application/json", "messageId": frame.Headers["messageId"]}, `{"response":null}`
	if system {
		headers, data = frame.Headers, frame.Data
	}
	response := dingpayload.DataFrameResponse{Code: 200, Headers: headers, Message: "OK", Data: data}
	return socket.Write(ctx, websocket.MessageText, response.Encode())
}

// ACK only after durable Core acceptance, and always on the originating socket.
// Official Node Stream SDK 2.1.7-beta.1 binds socketCallBackResponse to that socket.
// https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
func (c *Channel) receive(ctx context.Context, frame streamFrame) error {
	var message nativeMessage
	if json.Unmarshal([]byte(frame.Data), &message) != nil || message.ID == "" || message.SenderID == "" {
		return errors.New("invalid_dingtalk_message")
	}
	if message.RobotCode != c.config.RobotCode || message.SenderID == message.BotUserID || (message.ConversationType == "2" && !message.Mentioned) {
		return nil
	}
	if !common.Contains(c.account.AllowedSenders, message.SenderID) {
		return nil
	}
	if !common.Contains([]string{"text", "picture", "audio", "video", "file", "richText"}, message.Type) {
		return nil
	}
	chatID := message.StaffID
	kind := "single"
	if message.ConversationType == "2" {
		chatID = message.ConversationID
		kind = "group"
	} else if message.ConversationType != "1" {
		return nil
	}
	if chatID == "" {
		return nil
	}
	text, media, err := c.receiveContent(ctx, message)
	if err != nil {
		return err
	}
	if text == "" && len(media) == 0 {
		return nil
	}
	target := targetData{Type: kind, Scope: c.identity()}
	if kind == "group" {
		target.OpenConversationID = chatID
	} else {
		target.StaffID = chatID
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.DingTalk, AccountID: c.account.ID, EventID: message.ID}, SenderID: message.SenderID, Text: text, Attachments: media, Target: model.ReplyTarget{Channel: model.DingTalk, AccountID: c.account.ID, ChatID: chatID, ReplyToID: message.ID, Data: common.Data(target)}, ReceivedAt: time.Now()})
}

func (c *Channel) endpoint(ctx context.Context) (string, error) {
	secret, err := c.options.Secret(c.config.ClientSecret)
	if err != nil {
		return "", err
	}
	// The stream SDK's connection client owns an unbounded HTTP reader and does
	// not accept an injected client; reuse its native models with our transport.
	request := dingpayload.ConnectionEndpointRequest{ClientId: c.config.ClientID, ClientSecret: secret, UserAgent: "relanox-go/0.1.0", Subscriptions: []*dingpayload.SubscriptionModel{{Type: "CALLBACK", Topic: "/v1.0/im/bot/messages/get"}}}
	var response dingpayload.ConnectionEndpointResponse
	if err = common.JSON(ctx, c.options.HTTPClient, http.MethodPost, apiBase+"/v1.0/gateway/connections/open", nil, request, &response); err != nil {
		return "", err
	}
	endpoint, err := url.Parse(response.Endpoint)
	if err != nil || endpoint.Scheme != "wss" || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" || response.Ticket == "" {
		return "", errors.New("invalid_stream_endpoint")
	}
	query := endpoint.Query()
	query.Set("ticket", response.Ticket)
	endpoint.RawQuery = query.Encode()
	return endpoint.String(), nil
}

func (c *Channel) session(ctx context.Context) error {
	endpoint, err := c.endpoint(ctx)
	if err != nil {
		return err
	}
	socket, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPClient: common.HTTPClient(c.options.HTTPClient)})
	if err != nil {
		return err
	}
	defer socket.CloseNow()
	socket.SetReadLimit(1024 * 1024)
	c.host.Connection(model.Connected, "")
	// Each callback captures socket, so a late ACK cannot reach its replacement.
	// Workers are joined by the outer lifetime, not the session's reconnect path.
	for {
		_, raw, err := socket.Read(ctx)
		if err != nil {
			return err
		}
		var frame streamFrame
		if json.Unmarshal(raw, &frame) != nil || frame.Headers["messageId"] == "" {
			continue
		}
		if frame.Type == "SYSTEM" {
			topic := frame.Headers["topic"]
			if topic == "ping" || topic == "disconnect" {
				if err = acknowledge(ctx, socket, frame, true); err != nil {
					return err
				}
			}
			if topic == "disconnect" {
				return errors.New("stream_rotation")
			}
			continue
		}
		if frame.Type != "CALLBACK" || frame.Headers["topic"] != "/v1.0/im/bot/messages/get" {
			continue
		}
		select {
		case c.callbackGate <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		c.callbacks.Add(1)
		go func(frame streamFrame) {
			defer c.callbacks.Done()
			defer func() { <-c.callbackGate }()
			err := c.receive(ctx, frame)
			if err == nil || common.PolicyRejection(err) {
				_ = acknowledge(ctx, socket, frame, false)
			} else if ctx.Err() == nil {
				c.host.Connection(model.Degraded, "ingest_failed")
			}
		}(frame)
	}
}

func (c *Channel) connect(ctx context.Context) {
	defer c.callbacks.Wait()
	backoff := time.Second
	for ctx.Err() == nil {
		_ = c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		c.host.Connection(model.Degraded, "dingtalk_reconnecting")
		if common.Delay(ctx, backoff) != nil {
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}
