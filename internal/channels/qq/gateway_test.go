package qq

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/internal/channeltest"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type gatewayHost struct {
	testHost
	state     model.StateStore
	connected chan struct{}
}

func (h *gatewayHost) State() model.StateStore { return h.state }
func (h *gatewayHost) Connection(status model.ConnectionStatus, _ string) {
	if status == model.Connected && h.connected != nil {
		select {
		case h.connected <- struct{}{}:
		default:
		}
	}
}

type gatewayPeer struct {
	t                   *testing.T
	mu                  sync.Mutex
	connections, tokens int
	refresh             bool
	identifies          []gatewayFrame
	credentials         []string
	heartbeats          []int64
}

func (p *gatewayPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/app/getAppAccessToken":
		p.mu.Lock()
		p.tokens++
		count := p.tokens
		p.mu.Unlock()
		channeltest.WriteResponse(p.t, w, fmt.Sprintf(`{"access_token":"token-%d","expires_in":7200}`, count))
	case "/gateway":
		channeltest.WriteResponse(p.t, w, `{"url":"wss://gateway.qq.example/socket"}`)
	case "/socket":
		p.socket(w, r)
	default:
		p.t.Errorf("unexpected gateway path: %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

func (p *gatewayPeer) socket(w http.ResponseWriter, r *http.Request) {
	socket, err := websocket.Accept(w, r, nil)
	if err != nil {
		p.t.Error(err)
		return
	}
	defer func() { _ = socket.CloseNow() }()
	p.mu.Lock()
	p.connections++
	connection := p.connections
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err = socket.Write(ctx, websocket.MessageText, []byte(`{"op":10,"d":{"heartbeat_interval":50}}`)); err != nil {
		return
	}
	_, raw, err := socket.Read(ctx)
	if err != nil {
		p.t.Error(err)
		return
	}
	var frame gatewayFrame
	if json.Unmarshal(raw, &frame) != nil {
		p.t.Error("invalid identify/resume")
		return
	}
	var data struct {
		Token    string `json:"token"`
		Session  string `json:"session_id"`
		Sequence *int64 `json:"seq"`
		Intents  int    `json:"intents"`
	}
	if err = json.Unmarshal(frame.Data, &data); err != nil {
		p.t.Error(err)
		return
	}
	p.mu.Lock()
	p.identifies = append(p.identifies, frame)
	p.credentials = append(p.credentials, data.Token)
	p.mu.Unlock()
	if p.refresh {
		p.refreshSession(ctx, socket, connection)
		return
	}
	p.resumeSession(ctx, socket, connection, frame.Op, data.Session, data.Sequence, data.Intents)
}

func (p *gatewayPeer) refreshSession(ctx context.Context, socket *websocket.Conn, connection int) {
	if connection == 1 {
		_ = socket.Close(websocket.StatusCode(4004), "public auth failure")
		return
	}
	if err := socket.Write(ctx, websocket.MessageText, []byte(`{"op":0,"t":"READY","s":1,"d":{"session_id":"new-session"}}`)); err != nil {
		return
	}
	for {
		if _, _, err := socket.Read(ctx); err != nil {
			return
		}
	}
}

func (p *gatewayPeer) resumeSession(ctx context.Context, socket *websocket.Conn, connection, op int, session string, sequence *int64, intents int) {
	var events []string
	if connection == 1 {
		if op != 2 || intents != 1<<25 {
			p.t.Error("native IDENTIFY intents changed")
		}
		events = []string{`{"op":0,"t":"READY","s":1,"d":{"session_id":"native-session"}}`, `{"op":0,"t":"OTHER_EVENT","s":42,"d":{}}`}
	} else {
		if op != 6 || session != "native-session" || sequence == nil || *sequence != 42 {
			p.t.Error("durable RESUME cursor lost")
		}
		// Native replay may precede RESUMED; never clear the restored session.
		events = []string{`{"op":0,"t":"OTHER_EVENT","s":43,"d":{}}`, `{"op":0,"t":"RESUMED","s":44,"d":{}}`}
	}
	for _, event := range events {
		if err := socket.Write(ctx, websocket.MessageText, []byte(event)); err != nil {
			return
		}
	}
	_, raw, err := socket.Read(ctx)
	if err != nil {
		p.t.Error(err)
		return
	}
	var heartbeat struct {
		Op   int   `json:"op"`
		Data int64 `json:"d"`
	}
	if json.Unmarshal(raw, &heartbeat) != nil || heartbeat.Op != 1 {
		p.t.Error("missing native heartbeat")
		return
	}
	p.mu.Lock()
	p.heartbeats = append(p.heartbeats, heartbeat.Data)
	p.mu.Unlock()
	if err = socket.Write(ctx, websocket.MessageText, []byte(`{"op":11,"d":null}`)); err != nil {
		return
	}
	if err = socket.Write(ctx, websocket.MessageText, []byte(`{"op":7,"d":null}`)); err != nil {
		return
	}
	for {
		if _, _, err = socket.Read(ctx); err != nil {
			return
		}
	}
}

func openGateway(t *testing.T, file string, client *http.Client) (*Channel, *storage.Store, *gatewayHost) {
	t.Helper()
	store, err := storage.Open(context.Background(), config.Storage{Driver: "sqlite", Path: file}, nil)
	if err != nil {
		t.Fatal(err)
	}
	host := &gatewayHost{state: store.State(model.StateNamespace{Component: "channel", OwnerID: "account"}), connected: make(chan struct{}, 1)}
	c, err := New(host, model.AccountConfig{ID: "account", Channel: model.QQ, Config: common.Data(Config{AppID: "app", ClientSecret: model.SecretRef{Env: "SECRET"}})}, common.Options{HTTPClient: client, ResolveSecret: func(model.SecretRef) (string, error) { return "public-secret", nil }})
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	return c, store, host
}

// Protects IDENTIFY/heartbeat/RESUME and real SQLite session recovery, including
// native dispatch before RESUMED. Resetting seq on reconnect or saving only READY
// loses replay position. HTTP-send tests cover no socket/session state. No core
// ingestion is simulated: these are native lifecycle events and real StateStore.
func TestNativeGatewayResumesPersistedSequenceAfterReopen(t *testing.T) {
	// Native fixture: qqbot-nodejs 1.0.5 protocol/gateway/{constants,
	// gateway-connection,event-dispatcher}.ts. https://github.com/tencent-connect/qqbot-nodejs
	p := &gatewayPeer{t: t}
	client := redirectedClient(t, p)
	file := filepath.Join(t.TempDir(), "state.db")
	for run := 0; run < 2; run++ {
		runGatewaySession(t, file, client)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.connections != 2 || fmt.Sprint(p.heartbeats) != "[42 44]" {
		t.Fatalf("socket lifecycle: %d %v", p.connections, p.heartbeats)
	}
}

// The bound covers real SQLite writes on shared CI runners; this checks recovery,
// not five-second storage performance. Close the database even when a session
// assertion fails, and before the next session reopens the same file.
func runGatewaySession(t *testing.T, file string, client *http.Client) {
	t.Helper()
	c, store, _ := openGateway(t, file, client)
	defer func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	}()
	defer func() { _ = c.Close(context.Background()) }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ready, err := c.session(ctx)
	var reconnect *gatewayFailure
	if !ready || !errors.As(err, &reconnect) || reconnect.reset {
		t.Fatalf("native session: %t %v", ready, err)
	}
}

func TestNativeAuthCloseRefreshesTokenBeforeReconnect(t *testing.T) {
	p := &gatewayPeer{t: t, refresh: true}
	c, store, host := openGateway(t, filepath.Join(t.TempDir(), "state.db"), redirectedClient(t, p))
	defer func() { _ = store.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-host.connected:
	case <-ctx.Done():
		t.Fatal("native reconnect never reached READY")
	}
	if err := c.Close(ctx); err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.tokens != 2 || fmt.Sprint(p.credentials) != "[QQBot token-1 QQBot token-2]" {
		t.Fatalf("stale gateway token reused: %d %v", p.tokens, p.credentials)
	}
}
