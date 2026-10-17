package core_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/app"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/dingtalk"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type dingPeer struct {
	t              *testing.T
	ctx            context.Context
	oauthRequested chan struct{}
	oauthRelease   chan struct{}
	oauthOnce      sync.Once
	releaseOnce    sync.Once
	sessions       atomic.Int64
	replacement    chan *websocket.Conn
	acks           chan string
}

func (p *dingPeer) release() { p.releaseOnce.Do(func() { close(p.oauthRelease) }) }

func (p *dingPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/v1.0/gateway/connections/open":
		_ = json.NewEncoder(w).Encode(map[string]string{"endpoint": "wss://native-stream.example/events", "ticket": "native-ticket"})
	case "/v1.0/oauth2/accessToken":
		p.oauthOnce.Do(func() { close(p.oauthRequested) })
		select {
		case <-p.oauthRelease:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, `{"accessToken":"native-access-token","expireIn":7200}`)
	case "/routine":
		_, _ = io.Copy(io.Discard, r.Body)
		// Routine success receipt: https://cursor.com/help/grok-bot/routines#where-do-the-webhook-url-and-key-live-and-what-does-a-200-mean
		w.WriteHeader(http.StatusOK)
	case "/events":
		p.socket(w, r)
	default:
		p.t.Errorf("unexpected DingTalk native path %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

func (p *dingPeer) socket(w http.ResponseWriter, r *http.Request) {
	connection, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = connection.CloseNow() }()
	if r.URL.Query().Get("ticket") != "native-ticket" {
		p.t.Error("native Stream ticket missing")
		return
	}
	if p.sessions.Add(1) == 1 {
		p.rotate(connection)
		return
	}
	p.replacement <- connection
	if err = connection.Write(p.ctx, websocket.MessageText, dingCallback("new-fast", "fast", "fast message", false)); err != nil {
		return
	}
	for {
		_, data, err := connection.Read(p.ctx)
		if err != nil {
			return
		}
		var ack struct {
			Code    int               `json:"code"`
			Headers map[string]string `json:"headers"`
		}
		if json.Unmarshal(data, &ack) != nil || ack.Code != 200 {
			p.t.Error("invalid native Stream ACK")
			return
		}
		select {
		case p.acks <- ack.Headers["messageId"]:
		case <-p.ctx.Done():
			return
		}
	}
}

func (p *dingPeer) rotate(connection *websocket.Conn) {
	if err := connection.Write(p.ctx, websocket.MessageText, dingCallback("old-slow", "slow", "slow message", true)); err != nil {
		return
	}
	select {
	case <-p.oauthRequested:
	case <-p.ctx.Done():
		return
	}
	frame := common.Data(map[string]any{"type": "SYSTEM", "headers": map[string]string{"messageId": "rotate", "topic": "disconnect"}, "data": "native-rotation"})
	if err := connection.Write(p.ctx, websocket.MessageText, frame); err != nil {
		return
	}
	_, data, err := connection.Read(p.ctx)
	if err != nil {
		return
	}
	var ack struct {
		Code    int               `json:"code"`
		Headers map[string]string `json:"headers"`
		Data    string            `json:"data"`
	}
	if json.Unmarshal(data, &ack) != nil || ack.Code != 200 || ack.Headers["messageId"] != "rotate" || ack.Data != "native-rotation" {
		p.t.Error("callback was acknowledged before blocked native preparation reached durable acceptance, or SYSTEM echo changed")
		return
	}
	_, _, _ = connection.Read(p.ctx)
}

func dingCallback(frameID, eventID, message string, rich bool) []byte {
	body := map[string]any{"msgId": eventID, "conversationType": "1", "senderId": "alice", "senderStaffId": "alice", "chatbotUserId": "bot-user", "robotCode": "robot", "msgtype": "text", "text": map[string]string{"content": message}}
	if rich {
		delete(body, "text")
		body["msgtype"] = "richText"
		body["content"] = map[string]any{"richText": []any{map[string]string{"type": "text", "text": message}}}
	}
	return common.Data(map[string]any{"type": "CALLBACK", "headers": map[string]string{"messageId": frameID, "topic": "/v1.0/im/bot/messages/get"}, "data": string(common.Data(body))})
}

type dingTransport struct {
	base   http.RoundTripper
	origin *url.URL
}

func (t dingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.URL.Scheme = t.origin.Scheme
	r.URL.Host = t.origin.Host
	r.Host = t.origin.Host
	return t.base.RoundTrip(r)
}

func dingConfig(t *testing.T, path string) config.Config {
	t.Helper()
	account := model.AccountConfig{ID: "ding", Channel: model.DingTalk, AllowedSenders: []string{"alice"}, Config: common.Data(dingtalk.Config{ClientID: "app", RobotCode: "robot", ClientSecret: model.SecretRef{Env: "DING_APP_SECRET"}})}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Token: model.SecretRef{Env: "DING_MCP"}}, RoutineURL: model.SecretRef{Env: "DING_ROUTINE"}, RoutineAuthorization: model.SecretRef{Env: "DING_ROUTINE_AUTH"}})}
	cfg := relayConfig(t, "https://relay.example", account, endpoint, path)
	cfg.HTTP.Listen = "127.0.0.1:0"
	cfg.HTTP.ManagementListen = "127.0.0.1:0"
	return cfg
}

func awaitDingSource(t *testing.T, store *storage.Store, event string) []model.InboundRecord {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		records, err := store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
		if err != nil {
			t.Fatal(err)
		}
		for _, record := range records {
			if record.Snapshot.Source.EventID == event {
				return records
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("native event was not durably accepted")
	return nil
}

// Source: official Stream SDK's per-socket callback response contract.
// https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
// A callback delayed by native OAuth can finish after session rotation. Its ACK
// must stay on the old socket, and ACKs on the replacement must follow actual
// SQLite acceptance. Adapter send tests cannot protect this runtime boundary.
func TestDingTalkACKFollowsDurableAcceptanceAndOriginatingSocket(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	p := &dingPeer{t: t, ctx: ctx, oauthRequested: make(chan struct{}), oauthRelease: make(chan struct{}), replacement: make(chan *websocket.Conn, 1), acks: make(chan string, 8)}
	peer := httptest.NewTLSServer(p)
	defer peer.Close()
	origin, _ := url.Parse(peer.URL)
	client := peer.Client()
	client.Transport = dingTransport{base: client.Transport, origin: origin}
	t.Setenv("DING_APP_SECRET", "native-secret")
	t.Setenv("DING_MCP", "mcp-token")
	t.Setenv("DING_ROUTINE", "https://routine.example/routine")
	t.Setenv("DING_ROUTINE_AUTH", "Bearer routine")
	cfg := dingConfig(t, filepath.Join(t.TempDir(), "relay.db"))
	application, err := app.New(ctx, cfg, app.Options{HTTPClient: client, LogWriter: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { p.release(); _ = application.Close(context.Background()) }()
	if err = application.Start(ctx); err != nil {
		t.Fatal(err)
	}
	store, err := storage.OpenExisting(ctx, cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	}()
	var replacement *websocket.Conn
	select {
	case replacement = <-p.replacement:
	case <-ctx.Done():
		t.Fatal("native replacement socket did not connect")
	}
	select {
	case ack := <-p.acks:
		if ack != "new-fast" {
			t.Fatalf("unexpected replacement ACK %s", ack)
		}
	case <-ctx.Done():
		t.Fatal("new session callback was not acknowledged")
	}
	records := awaitDingSource(t, store, "fast")
	if len(records) != 1 {
		t.Fatal("slow native callback accepted before its OAuth completed")
	}
	p.release()
	awaitDingSource(t, store, "slow")
	if err = replacement.Write(ctx, websocket.MessageText, dingCallback("new-slow-replay", "slow", "slow message", false)); err != nil {
		t.Fatal(err)
	}
	select {
	case ack := <-p.acks:
		if ack != "new-slow-replay" {
			t.Fatalf("old callback ACK escaped onto replacement: %s", ack)
		}
	case <-ctx.Done():
		t.Fatal("replacement replay was not acknowledged")
	}
	records = awaitDingSource(t, store, "slow")
	if len(records) != 2 {
		t.Fatalf("native replay duplicated durable inputs: %d", len(records))
	}
	if err = application.Close(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case ack := <-p.acks:
		t.Fatalf("unexpected late ACK on replacement: %s", ack)
	default:
	}
}
