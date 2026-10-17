package core_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/muse"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/wechat"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
	"google.golang.org/protobuf/encoding/protowire"
)

// This peer models only official external Muse HTTP, Noise XX/AESGCM and
// protobuf envelopes. An independent Noise implementation avoids reusing code
// under test. Source field numbers and ACK shape are from the verified SDK:
// https://github.com/facebookincubator/muse-gadget-sdk/tree/fa073045a5572a8e3367fae142c1b7a7c554f222/linux/src/musegadget/noise
type musePeer struct {
	t       *testing.T
	delay   time.Duration
	hold    bool
	started chan struct{}
	chat    chan []byte
	once    sync.Once
}

func (p *musePeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/fetch_vms":
		p.once.Do(func() { close(p.started) })
		if p.hold {
			<-r.Context().Done()
			return
		}
		timer := time.NewTimer(p.delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, `{"vm_list":[{"vm_id":"vm-A","vm_ws_url":"wss://unused.example/vm","vm_auth_token":"vm-token","default":true}]}`)
	case "/v1/noise":
		if r.Header.Get("Authorization") != "Bearer vm-token" || r.URL.Query().Get("vm_id") != "vm-A" {
			p.t.Error("native Noise authentication changed")
			w.WriteHeader(401)
			return
		}
		body, err := serveMuseNoise(w, r)
		if err != nil {
			p.t.Error(err)
			return
		}
		p.chat <- body
	default:
		p.t.Errorf("unexpected Muse request %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

func serveMuseNoise(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return nil, err
	}
	defer conn.CloseNow()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	receive, send, err := museHandshake(ctx, conn)
	if err != nil {
		return nil, err
	}
	_, ciphertext, err := conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	plain, err := receive.Decrypt(nil, nil, ciphertext)
	if err != nil {
		return nil, err
	}
	payload, err := protobufBytes(plain, 4)
	if err != nil {
		return nil, err
	}
	frame, err := protobufBytes(payload, 2)
	if err != nil {
		return nil, err
	}
	request, err := protobufBytes(frame, 2)
	if err != nil {
		return nil, err
	}
	method, err := protobufBytes(request, 1)
	if err != nil || string(method) != "POST" {
		return nil, errors.New("native application verb changed")
	}
	path, err := protobufBytes(request, 2)
	if err != nil || string(path) != "/chat/stream" {
		return nil, errors.New("native application path changed")
	}
	body, err := protobufBytes(request, 4)
	if err != nil {
		return nil, err
	}
	ack := protobufUint(nil, 1, 200)
	ack = protobufAppendBytes(ack, 3, []byte(`{"result":{"message_id":"native-message"}}`))
	ack = protobufUint(ack, 4, 1)
	response := protobufUint(nil, 1, 1)
	response = protobufAppendBytes(response, 3, ack)
	response = protobufAppendBytes(nil, 1, response)
	chunk := protobufUint(nil, 1, 99)
	chunk = protobufUint(chunk, 2, 0)
	chunk = protobufUint(chunk, 3, 1)
	chunk = protobufAppendBytes(chunk, 4, response)
	encrypted, err := send.Encrypt(nil, nil, chunk)
	if err != nil {
		return nil, err
	}
	return body, conn.Write(ctx, websocket.MessageBinary, encrypted)
}

func museHandshake(ctx context.Context, conn *websocket.Conn) (*noise.CipherState, *noise.CipherState, error) {
	suite := noise.NewCipherSuite(noise.DH25519, noise.CipherAESGCM, noise.HashSHA256)
	static, err := suite.GenerateKeypair(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	handshake, err := noise.NewHandshakeState(noise.Config{CipherSuite: suite, Pattern: noise.HandshakeXX, StaticKeypair: static})
	if err != nil {
		return nil, nil, err
	}
	_, first, err := conn.Read(ctx)
	if err != nil {
		return nil, nil, err
	}
	if _, _, _, err = handshake.ReadMessage(nil, first); err != nil {
		return nil, nil, err
	}
	second, _, _, err := handshake.WriteMessage(nil, nil)
	if err != nil {
		return nil, nil, err
	}
	if err = conn.Write(ctx, websocket.MessageBinary, second); err != nil {
		return nil, nil, err
	}
	_, third, err := conn.Read(ctx)
	if err != nil {
		return nil, nil, err
	}
	_, receive, send, err := handshake.ReadMessage(nil, third)
	return receive, send, err
}

func protobufBytes(data []byte, wanted protowire.Number) ([]byte, error) {
	for len(data) > 0 {
		number, kind, read := protowire.ConsumeTag(data)
		if read < 0 {
			return nil, errors.New("invalid protobuf tag")
		}
		data = data[read:]
		size := protowire.ConsumeFieldValue(number, kind, data)
		if size < 0 {
			return nil, errors.New("invalid protobuf value")
		}
		if number == wanted && kind == protowire.BytesType {
			value, _ := protowire.ConsumeBytes(data)
			return value, nil
		}
		data = data[size:]
	}
	return nil, errors.New("missing protobuf field")
}

func protobufUint(out []byte, number protowire.Number, value uint64) []byte {
	return protowire.AppendVarint(protowire.AppendTag(out, number, protowire.VarintType), value)
}

func protobufAppendBytes(out []byte, number protowire.Number, value []byte) []byte {
	return protowire.AppendBytes(protowire.AppendTag(out, number, protowire.BytesType), value)
}

func newMuseRelay(t *testing.T, peer *musePeer) (*core.Runtime, *storage.Store, context.CancelFunc) {
	t.Helper()
	server := httptest.NewTLSServer(peer)
	native := newWeChatPeer(t, make(chan wechat.Message, 4))
	directory := t.TempDir()
	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	credentials := map[string]any{"access_token": "public-access", "refresh_token": "hatch_refresh:public-refresh", "api_url_v2": server.URL, "noise_host": u.Host}
	for name, data := range map[string][]byte{"pairing.json": common.Data(credentials), "identity.json": []byte(`{"mac":"00:11:22:33:44:55"}`), "sdk_token": []byte("sdk-public")} {
		if err := os.WriteFile(filepath.Join(directory, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	account := model.AccountConfig{ID: "wechat", Channel: model.WeChat, AllowedSenders: []string{"alice"}, Config: common.Data(wechat.Config{BotID: "bot", BotToken: model.SecretRef{Env: "PUBLIC_WECHAT"}, APIBaseURL: native.URL, CDNBaseURL: native.URL + "/c2c", AllowInsecureLoopback: true})}
	endpoint := model.EndpointConfig{ID: "muse", Agent: model.Muse, Config: common.Data(muse.Config{MCP: agentmcp.Config{Auth: "bearer", Token: model.SecretRef{Env: "PUBLIC_MCP"}}, CredentialsDirectory: model.SecretRef{Env: "PUBLIC_DIRECTORY"}, SessionID: "native-session"})}
	cfg := relayConfig(t, "http://127.0.0.1:8787", account, endpoint, filepath.Join(t.TempDir(), "muse.db"))
	lifetime, cancel := context.WithCancel(context.Background())
	store, err := storage.Open(lifetime, cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := core.New(cfg, store, core.Options{})
	if err != nil {
		t.Fatal(err)
	}
	host, err := runtime.ChannelHost(account.ID)
	if err != nil {
		t.Fatal(err)
	}
	resolve := func(ref model.SecretRef) (string, error) {
		if ref.Env == "PUBLIC_DIRECTORY" {
			return directory, nil
		}
		return "public-fixture-secret", nil
	}
	channel, err := wechat.New(host, account, common.Options{HTTPClient: native.Client(), ResolveSecret: resolve})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.AttachChannel(account.ID, channel); err != nil {
		t.Fatal(err)
	}
	agentHost, err := runtime.AgentHost(model.Muse)
	if err != nil {
		t.Fatal(err)
	}
	agent, err := muse.New(endpoint, agentmcp.Dependencies{Host: agentHost, ResolveSecret: resolve, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.AttachAgent(endpoint.ID, agent); err != nil {
		t.Fatal(err)
	}
	if err = runtime.Start(lifetime); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		shutdown, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		if err := runtime.Close(shutdown); err != nil {
			t.Error(err)
		}
		native.Close()
		server.Close()
		_ = store.Close()
	})
	return runtime, store, cancel
}

func TestDefaultWorkerAllowsSlowNativeMusePrechat(t *testing.T) {
	// The old unconditional 10-second outer race discarded an unsent native
	// lookup. This real 11-second fetch must reach Noise and settle Accepted
	// under the default 60-second lease / 40-second dispatch budget.
	peer := &musePeer{t: t, delay: 11 * time.Second, started: make(chan struct{}), chat: make(chan []byte, 1)}
	_, store, _ := newMuseRelay(t, peer)
	select {
	case body := <-peer.chat:
		var request map[string]string
		if json.Unmarshal(body, &request) != nil || request["session_id"] != "native-session" || !strings.Contains(request["message"], "original input") {
			t.Fatalf("invalid native chat: %s", body)
		}
	case <-time.After(18 * time.Second):
		t.Fatal("default worker cut off a valid native pre-chat stage")
	}
	record := awaitInbound(t, store, model.AttemptAccepted)
	if record.Dispatch.Attempts != 1 {
		t.Fatalf("slow native operation was retried: %#v", record.Dispatch)
	}
}

func TestCancelledNativeMusePrechatSettlesRetryable(t *testing.T) {
	peer := &musePeer{t: t, hold: true, started: make(chan struct{}), chat: make(chan []byte, 1)}
	runtime, store, cancel := newMuseRelay(t, peer)
	select {
	case <-peer.started:
	case <-time.After(3 * time.Second):
		t.Fatal("native lookup was not reached")
	}
	cancel()
	shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err := runtime.Close(shutdown); err != nil {
		t.Fatal(err)
	}
	record := awaitInbound(t, store, model.AttemptDue)
	if record.Dispatch.Lease != nil || record.Dispatch.Attempts != 1 || record.Dispatch.ErrorCode != "muse_connect_failed" {
		t.Fatalf("unsent cancellation became unknown: %s", fmt.Sprint(record.Dispatch))
	}
	select {
	case <-peer.chat:
		t.Fatal("cancelled lookup transmitted a chat")
	default:
	}
}
