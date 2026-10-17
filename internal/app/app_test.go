package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/relanox/relanox/internal/app"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type bearer struct{ base http.RoundTripper }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Host = "relay.example"
	r.Header.Set("Authorization", "Bearer mcp-secret")
	return b.base.RoundTrip(r)
}

// Protects executable composition, authenticated native ingress, durable worker
// wiring and listener separation. Core protocol tests construct their own
// runtime; they cannot catch an omitted constructor or miswired app listener.
// Native envelopes: https://core.telegram.org/bots/api#update and #sendmessage.
func TestApplicationNativeRoundTripAndPrivateManagement(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	notifications := make(chan struct{}, 4)
	sends := make(chan map[string]any, 4)
	peer := nativePeer(t, notifications, sends)
	defer peer.Close()
	t.Setenv("APP_BOT", "123:bot-secret")
	t.Setenv("APP_WEBHOOK", "webhook-secret")
	t.Setenv("APP_MCP", "mcp-secret")
	t.Setenv("APP_ROUTINE", peer.URL+"/routine")
	t.Setenv("APP_AUTH", "routine-secret")
	data, _ := json.Marshal(map[string]any{
		"storage": map[string]any{"driver": "sqlite", "path": "state/relay.db"}, "http": map[string]any{"listen": "127.0.0.1:0", "managementListen": "127.0.0.1:0", "publicUrl": "https://relay.example"}, "queue": map[string]any{"pollIntervalMs": 5}, "observability": map[string]any{"metrics": true},
		"accounts":  []any{map[string]any{"id": "telegram", "channel": "telegram", "allowedSenders": []string{"22"}, "config": map[string]any{"botToken": model.SecretRef{Env: "APP_BOT"}, "webhookSecret": model.SecretRef{Env: "APP_WEBHOOK"}, "apiBaseUrl": peer.URL}}},
		"endpoints": []any{map[string]any{"id": "grok", "agent": "grok", "config": map[string]any{"mcp": map[string]any{"token": model.SecretRef{Env: "APP_MCP"}}, "routineUrl": model.SecretRef{Env: "APP_ROUTINE"}, "routineAuthorization": model.SecretRef{Env: "APP_AUTH"}}}},
		"bindings":  []model.Binding{{AccountID: "telegram", ChatID: "-1001", EndpointID: "grok"}},
	})
	cfg, err := config.Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Path = filepath.Join(t.TempDir(), "relay.json")
	application, err := app.New(ctx, cfg, app.Options{HTTPClient: peer.Client(), LogWriter: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = application.Close(context.Background()) })
	if err = application.Start(ctx); err != nil {
		t.Fatal(err)
	}
	public, management := application.Addresses()
	public = "http://" + public
	management = "http://" + management
	for _, path := range []string{"/health/live", "/health/ready", "/metrics"} {
		assertStatus(t, management+path, 200)
		assertStatus(t, public+path, 404)
	}
	request, _ := http.NewRequestWithContext(ctx, "POST", public+"/channels/telegram/telegram/webhook", strings.NewReader(`{"update_id":7,"message":{"message_id":8,"from":{"id":22,"is_bot":false},"chat":{"id":-1001,"type":"supergroup"},"text":"operator input"}}`))
	request.Header.Set("X-Telegram-Bot-Api-Secret-Token", "webhook-secret")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("webhook=%d", response.StatusCode)
	}
	select {
	case <-notifications:
	case <-ctx.Done():
		t.Fatal("application did not dispatch to Grok")
	}
	encoded := roundTripMCP(t, ctx, public, sends)
	if err = application.Close(ctx); err != nil {
		t.Fatal(err)
	}
	connection, err := net.DialTimeout("tcp", strings.TrimPrefix(public, "http://"), 100*time.Millisecond)
	if err == nil {
		connection.Close()
		t.Fatal("public listener survived Close")
	}
	assertStoredInput(t, ctx, cfg)
	if bytes.Contains(encoded, []byte("bot-secret")) {
		t.Fatal("public message exposed credential")
	}
}

func assertStatus(t *testing.T, address string, want int) {
	t.Helper()
	response, err := http.Get(address)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != want {
		t.Fatalf("%s=%d want %d", address, response.StatusCode, want)
	}
}

// A management bind failure must close the already acquired public listener and
// the database, so a corrected run can start immediately on the same paths.
func TestFailedManagementBindReleasesPublicListener(t *testing.T) {
	reserved, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := reserved.Addr().String()
	reserved.Close()
	blocked, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer blocked.Close()
	data, _ := json.Marshal(map[string]any{"storage": map[string]any{"driver": "sqlite", "path": filepath.Join(t.TempDir(), "relay.db")}, "http": map[string]any{"listen": address, "managementListen": blocked.Addr().String()}})
	cfg, err := config.Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	application, err := app.New(context.Background(), cfg, app.Options{LogWriter: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err = application.Start(context.Background()); err == nil {
		t.Fatal("occupied management address accepted")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("public listener leaked: %v", err)
	}
	listener.Close()
}

func nativePeer(t *testing.T, notifications chan<- struct{}, sends chan<- map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/routine":
			if r.Header.Get("Authorization") != "routine-secret" {
				t.Error("routine credential missing")
				w.WriteHeader(401)
				return
			}
			_, _ = io.Copy(io.Discard, r.Body)
			notifications <- struct{}{}
			// Routine success receipt: https://cursor.com/help/grok-bot/routines#where-do-the-webhook-url-and-key-live-and-what-does-a-200-mean
			w.WriteHeader(http.StatusOK)
		case "/bot123:bot-secret/sendMessage":
			// Telegram accepts multipart for every method; the SDK uses it for
			// sendMessage too. https://core.telegram.org/bots/api#making-requests
			if r.ParseMultipartForm(1024*1024) != nil {
				t.Error("native body invalid")
				w.WriteHeader(400)
				return
			}
			defer r.MultipartForm.RemoveAll()
			body := map[string]any{"text": r.FormValue("text"), "chat_id": r.FormValue("chat_id")}
			sends <- body
			_, _ = io.WriteString(w, `{"ok":true,"result":{"message_id":102}}`)
		default:
			t.Errorf("unexpected peer path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
}

func assertStoredInput(t *testing.T, ctx context.Context, cfg config.Config) {
	t.Helper()
	store, err := storage.OpenExisting(ctx, config.Storage{Driver: "sqlite", Path: cfg.ResolvePath(cfg.Storage.Path)}, cfg.ResolveSecret)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	records, err := store.ListInbound(ctx, model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 {
		t.Fatalf("durable record=%v %v", records, err)
	}
	if records[0].Snapshot.Text != "operator input" {
		t.Fatal("public/private projection or durable text changed")
	}
}

func roundTripMCP(t *testing.T, ctx context.Context, public string, sends <-chan map[string]any) []byte {
	t.Helper()
	wrongHost, _ := http.NewRequestWithContext(ctx, "GET", public+"/agents/grok/mcp/grok", nil)
	wrongHost.Host = "unconfigured.example"
	wrongHost.Header.Set("Authorization", "Bearer mcp-secret")
	response, err := http.DefaultClient.Do(wrongHost)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("unconfigured MCP Host=%d", response.StatusCode)
	}
	client := &http.Client{Transport: bearer{base: http.DefaultTransport}}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "application-test", Version: "1"}, nil).Connect(ctx, &mcp.StreamableClientTransport{Endpoint: public + "/agents/grok/mcp/grok", HTTPClient: client, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	read, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "relanox_read_messages", Arguments: map[string]any{}})
	if err != nil || read.IsError {
		t.Fatalf("read=%#v %v", read, err)
	}
	encoded, _ := json.Marshal(read.StructuredContent)
	var messages struct {
		Messages []struct {
			RequestID string `json:"requestId"`
			Text      string `json:"text"`
			Source    struct {
				Channel model.ChannelAddress `json:"channel"`
			} `json:"source"`
		} `json:"messages"`
	}
	if json.Unmarshal(encoded, &messages) != nil || len(messages.Messages) != 1 {
		t.Fatalf("messages=%s", encoded)
	}
	message := messages.Messages[0]
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "relanox_send_message", Arguments: map[string]any{"channel": message.Source.Channel.ID, "text": "operator answer", "idempotencyKey": "reply-key", "reply": map[string]any{"requestId": message.RequestID, "kind": "final"}}})
	if err != nil || result.IsError {
		t.Fatalf("send=%#v %v", result, err)
	}
	select {
	case sent := <-sends:
		if sent["text"] != "operator answer" || sent["chat_id"] != "-1001" {
			t.Fatalf("native send=%#v", sent)
		}
	case <-ctx.Done():
		t.Fatal("native final was not sent")
	}
	_ = session.Close()
	return encoded
}
