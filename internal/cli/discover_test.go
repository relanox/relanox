package cli

import (
	"bytes"
	"context"
	"encoding/json"
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
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/wecom"
	"github.com/relanox/relanox/internal/model"
)

type discoveryOutput struct {
	mu    sync.Mutex
	data  bytes.Buffer
	found chan struct{}
	once  sync.Once
}

func (w *discoveryOutput) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if bytes.Contains(data, []byte(`"chatId"`)) {
		w.once.Do(func() { close(w.found) })
	}
	return w.data.Write(data)
}

type websocketPeerTransport struct {
	base   http.RoundTripper
	origin *url.URL
}

func (r websocketPeerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.URL.Scheme = r.origin.Scheme
	request.URL.Host = r.origin.Host
	request.Host = r.origin.Host
	return r.base.RoundTrip(request)
}

// The old discovery command works before an allowlist/binding exists. This
// actual native socket test guards that isolated workflow without inventing a
// fake relay host that routes, persists or authorizes messages.
// Frames: https://github.com/WecomTeam/aibot-node-sdk (WsConnectionManager).
func TestDiscoveryUsesNativeSocketAndPrintsOnlyAddresses(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = connection.CloseNow() }()
		_, data, err := connection.Read(ctx)
		if err != nil {
			return
		}
		var subscribe struct {
			Command string `json:"cmd"`
			Headers struct {
				RequestID string `json:"req_id"`
			} `json:"headers"`
			Body struct {
				BotID  string `json:"bot_id"`
				Secret string `json:"secret"`
			} `json:"body"`
		}
		if json.Unmarshal(data, &subscribe) != nil || subscribe.Command != "aibot_subscribe" || subscribe.Body.BotID != "native-bot" || subscribe.Body.Secret != "native-secret" {
			t.Error("native discovery subscription invalid")
			return
		}
		ack, _ := json.Marshal(map[string]any{"headers": map[string]any{"req_id": subscribe.Headers.RequestID}, "errcode": 0})
		if err = connection.Write(ctx, websocket.MessageText, ack); err != nil {
			return
		}
		message := []byte(`{"cmd":"aibot_msg_callback","headers":{"req_id":"native-request"},"body":{"msgid":"native-message","aibotid":"native-bot","chatid":"native-group","chattype":"group","from":{"userid":"native-sender"},"msgtype":"text","text":{"content":"private message must never print"}}}`)
		_ = connection.Write(ctx, websocket.MessageText, message)
		_ = connection.Write(ctx, websocket.MessageText, message)
		_, _, _ = connection.Read(ctx)
	}))
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "draft.json")
	if err := os.WriteFile(path, []byte(`{"accounts":[{"id":"draft","channel":"wecom","config":{"botId":"native-bot","secret":{"env":"DISCOVERY_NATIVE_SECRET"}}}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DISCOVERY_NATIVE_SECRET", "native-secret")
	cfg, account, err := discoveryAccount(path, "draft", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	origin, _ := url.Parse(peer.URL)
	out := &discoveryOutput{found: make(chan struct{})}
	c := &command{json: true, options: Options{Out: out, Err: io.Discard}}
	host := &discoveryHost{command: c, seen: map[model.DiscoveredConversation]bool{}}
	channel, err := wecom.New(host, account, common.Options{ResolveSecret: cfg.ResolveSecret, HTTPClient: &http.Client{Transport: websocketPeerTransport{base: http.DefaultTransport, origin: origin}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = channel.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-out.found:
	case <-ctx.Done():
		t.Fatal("native conversation was not discovered")
	}
	if err = channel.Close(ctx); err != nil {
		t.Fatal(err)
	}
	printed := out.data.String()
	if strings.Count(printed, `"chatId"`) != 1 || !strings.Contains(printed, "native-group") || !strings.Contains(printed, "native-sender") {
		t.Fatalf("native address/dedup lost: %s", printed)
	}
	if strings.Contains(printed, "private message") || strings.Contains(printed, "native-secret") {
		t.Fatal("discovery printed content or credentials")
	}
}
