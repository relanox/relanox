package core_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/wechat"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// These tests exercise real native HTTP, the official MCP SDK, the production
// core and real SQLite. They protect authorization, immutable source identity,
// recovery cursors and final delivery. Interface mocks or adapter-only tests
// cannot detect mistakes between these layers. Peers implement no relay logic.
// Tencent's external fixture contracts:
// https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts
// https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
type relayFixture struct {
	runtime       *core.Runtime
	store         *storage.Store
	host          model.ChannelHost
	relay         *httptest.Server
	wechatPeer    *httptest.Server
	routine       *httptest.Server
	notifications chan map[string]any
	sends         chan wechat.Message
	ctx           context.Context
	cancel        context.CancelFunc
}

func relayConfig(t *testing.T, origin string, account model.AccountConfig, endpoint model.EndpointConfig, path string) config.Config {
	t.Helper()
	cfg := config.Config{Accounts: []model.AccountConfig{account}, Endpoints: []model.EndpointConfig{endpoint}, Bindings: []model.Binding{{AccountID: account.ID, ChatID: "alice", EndpointID: endpoint.ID}}, Storage: config.Storage{Driver: "sqlite", Path: path}, HTTP: config.HTTP{PublicURL: origin}, Queue: config.Queue{Concurrency: 1, PollIntervalMS: 5}}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err = config.Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func newRelayFixture(t *testing.T, options core.Options) *relayFixture {
	t.Helper()
	f := &relayFixture{notifications: make(chan map[string]any, 32), sends: make(chan wechat.Message, 32)}
	f.ctx, f.cancel = context.WithCancel(context.Background())
	f.wechatPeer = newWeChatPeer(t, f.sends)
	f.routine = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var envelope struct {
			Content string `json:"content"`
		}
		if json.NewDecoder(r.Body).Decode(&envelope) != nil {
			t.Error("invalid Routine envelope")
			w.WriteHeader(400)
			return
		}
		var message map[string]any
		if json.Unmarshal([]byte(envelope.Content), &message) != nil {
			t.Error("invalid native content")
			w.WriteHeader(400)
			return
		}
		select {
		case f.notifications <- message:
		case <-r.Context().Done():
			return
		}
		w.WriteHeader(204)
	}))
	f.relay = httptest.NewUnstartedServer(nil)
	origin := "http://" + f.relay.Listener.Addr().String()
	account := model.AccountConfig{ID: "wechat", Channel: model.WeChat, AllowedSenders: []string{"alice"}, Config: common.Data(wechat.Config{BotID: "bot", BotToken: model.SecretRef{Env: "TEST_WECHAT"}, APIBaseURL: f.wechatPeer.URL, CDNBaseURL: f.wechatPeer.URL + "/c2c", AllowInsecureLoopback: true})}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Auth: "bearer", Token: model.SecretRef{Env: "TEST_MCP"}}, RoutineURL: model.SecretRef{Env: "TEST_ROUTINE"}, RoutineAuthorization: model.SecretRef{Env: "TEST_ROUTINE_AUTH"}})}
	cfg := relayConfig(t, origin, account, endpoint, filepath.Join(t.TempDir(), "relay.db"))
	var err error
	f.store, err = storage.Open(f.ctx, cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.runtime, err = core.New(cfg, f.store, options)
	if err != nil {
		t.Fatal(err)
	}
	f.host, err = f.runtime.ChannelHost(account.ID)
	if err != nil {
		t.Fatal(err)
	}
	secret := func(ref model.SecretRef) (string, error) {
		return map[string]string{"TEST_WECHAT": "native-token", "TEST_MCP": "mcp-token", "TEST_ROUTINE": f.routine.URL, "TEST_ROUTINE_AUTH": "Bearer routine-token"}[ref.Env], nil
	}
	channel, err := wechat.New(f.host, account, common.Options{HTTPClient: f.wechatPeer.Client(), ResolveSecret: secret})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runtime.AttachChannel(account.ID, channel); err != nil {
		t.Fatal(err)
	}
	host, err := f.runtime.AgentHost(model.Grok)
	if err != nil {
		t.Fatal(err)
	}
	agent, err := grok.New(endpoint, agentmcp.Dependencies{Host: host, ResolveSecret: secret, HTTPClient: f.routine.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runtime.AttachAgent(endpoint.ID, agent); err != nil {
		t.Fatal(err)
	}
	f.relay.Config.Handler = f.runtime.Handler()
	f.relay.Start()
	if err = f.runtime.Start(f.ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		f.cancel()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := f.runtime.Close(shutdown); err != nil {
			t.Error(err)
		}
		f.relay.Close()
		f.wechatPeer.Close()
		f.routine.Close()
		_ = f.store.Close()
	})
	return f
}

func newWeChatPeer(t *testing.T, sends chan<- wechat.Message) *httptest.Server {
	t.Helper()
	var first atomic.Bool
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/ilink/bot/getupdates":
			_, _ = io.Copy(io.Discard, r.Body)
			if first.CompareAndSwap(false, true) {
				_, _ = io.WriteString(w, `{"ret":0,"msgs":[{"message_id":18446744073709551615,"from_user_id":"alice","to_user_id":"bot","message_type":1,"message_state":2,"context_token":"private-native-target","item_list":[{"type":1,"text_item":{"text":"original input"}}]}],"get_updates_buf":"durable-cursor"}`)
				return
			}
			<-r.Context().Done()
		case "/ilink/bot/sendmessage":
			var envelope struct {
				Message wechat.Message `json:"msg"`
			}
			if json.NewDecoder(r.Body).Decode(&envelope) != nil {
				t.Error("bad WeChat send envelope")
				w.WriteHeader(400)
				return
			}
			select {
			case sends <- envelope.Message:
			case <-r.Context().Done():
				return
			}
			_, _ = io.WriteString(w, `{"ret":0}`)
		case "/ilink/bot/getuploadurl":
			_, _ = io.Copy(io.Discard, r.Body)
			_, _ = io.WriteString(w, `{"upload_param":"public-upload-ticket"}`)
		case "/c2c/upload":
			_, _ = io.Copy(io.Discard, r.Body)
			if r.URL.Query().Get("encrypted_query_param") != "public-upload-ticket" || r.Header.Get("Authorization") != "" {
				t.Error("invalid native CDN upload boundary")
			}
			w.Header().Set("x-encrypted-param", "public-download-ticket")
		default:
			t.Errorf("unexpected WeChat operation %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
}

func awaitInbound(t *testing.T, store *storage.Store, status model.AttemptStatus) *model.InboundRecord {
	t.Helper()
	return awaitInboundRecord(t, store, "", status)
}

type bearerTransport struct{ base http.RoundTripper }

func (t bearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.Header.Set("Authorization", "Bearer mcp-token")
	return t.base.RoundTrip(request)
}

func connectMCP(t *testing.T, f *relayFixture) *mcp.ClientSession {
	t.Helper()
	client := *f.relay.Client()
	client.Transport = bearerTransport{base: client.Transport}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "native-core-test", Version: "1"}, nil).Connect(f.ctx, &mcp.StreamableClientTransport{Endpoint: f.relay.URL + "/agents/grok/mcp/grok", HTTPClient: &client, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func callTool[T any](t *testing.T, f *relayFixture, session *mcp.ClientSession, name string, input any) T {
	t.Helper()
	result, err := session.CallTool(f.ctx, &mcp.CallToolParams{Name: name, Arguments: input})
	if err != nil || result == nil || result.IsError {
		t.Fatalf("%s: %#v %v", name, result, err)
	}
	data, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var out T
	if err = json.Unmarshal(data, &out); err != nil {
		t.Fatalf("%s decode %s: %v", name, data, err)
	}
	return out
}

func TestNativeHTTPToMCPAndFinalDelivery(t *testing.T) {
	f := newRelayFixture(t, core.Options{})
	record := awaitInbound(t, f.store, model.AttemptAccepted)
	if record.Snapshot.Source.EventID != "18446744073709551615" || record.Snapshot.AcceptedAt.UnixNano()%int64(time.Millisecond) != 0 {
		t.Fatal("native ID or cursor timestamp precision changed")
	}
	session := connectMCP(t, f)
	read := callTool[struct {
		Messages []map[string]any `json:"messages"`
	}](t, f, session, "relanox_read_messages", map[string]any{"requestId": record.Snapshot.RequestID})
	data, _ := json.Marshal(read)
	if len(read.Messages) != 1 || !strings.Contains(string(data), "original input") || strings.Contains(string(data), "private-native-target") || strings.Contains(string(data), "routineAuthorization") {
		t.Fatalf("unsafe public message projection: %s", data)
	}
	input := map[string]any{"channel": record.Snapshot.Channel.ID, "text": "final answer", "idempotencyKey": "send-key", "reply": map[string]string{"requestId": record.Snapshot.RequestID, "kind": "final"}}
	receipt := callTool[model.MessageReceipt](t, f, session, "relanox_send_message", input)
	if receipt.Status != model.Queued || receipt.Replay {
		t.Fatalf("not durably queued: %#v", receipt)
	}
	select {
	case sent := <-f.sends:
		if sent.To != "alice" || sent.ContextToken != "private-native-target" || len(sent.Items) != 1 || sent.Items[0].Text.Text != "final answer" {
			t.Fatalf("native target or content lost: %#v", sent)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("native final never sent")
	}
	awaitDelivery(t, f.store, receipt.DeliveryID, model.DeliverySent)
	input["idempotencyKey"] = "different-key-same-final"
	replay := callTool[model.MessageReceipt](t, f, session, "relanox_send_message", input)
	if !replay.Replay || replay.DeliveryID != receipt.DeliveryID {
		t.Fatalf("final replay duplicated native send: %#v", replay)
	}
	status := callTool[model.AgentStatus](t, f, session, "relanox_status", map[string]string{"requestId": record.Snapshot.RequestID})
	if status.Request == nil || status.Request.Reply.Status != model.Sent {
		t.Fatalf("final completion lost: %#v", status)
	}
}

func awaitDelivery(t *testing.T, store *storage.Store, id string, status model.DeliveryStatus) {
	t.Helper()
	waitForQueue(t, "durable delivery "+id+" to reach "+string(status), func(ctx context.Context) (bool, string, error) {
		record, err := store.GetOutbound(ctx, id)
		if err != nil {
			return false, "read failed", err
		}
		if record == nil {
			return false, "delivery absent", nil
		}
		detail := fmt.Sprintf("status=%s chunk=%d/%d version=%d attempts=%d error=%q lease=%v", record.Status, record.CurrentChunk, len(record.Chunks), record.Version, record.Attempts, record.ErrorCode, record.Lease)
		if record.Status == status {
			return true, detail, nil
		}
		if record.Status != model.DeliveryPending {
			return false, detail, fmt.Errorf("unexpected terminal delivery status %s", record.Status)
		}
		return false, detail, nil
	})
}

func TestCoreRejectsScopeAndKeepsDiscoverySeparate(t *testing.T) {
	f := newRelayFixture(t, core.Options{})
	record := awaitInbound(t, f.store, model.AttemptAccepted)
	input := model.IngestInput{Source: model.SourceKey{Channel: model.WeChat, AccountID: "wechat", EventID: "unauthorized"}, SenderID: "intruder", Text: "blocked", Target: record.Snapshot.Target, ReceivedAt: time.Now()}
	if _, err := f.host.Ingest(f.ctx, input); err == nil {
		t.Fatal("sender escaped allowlist")
	}
	input.SenderID = "alice"
	input.Target.ChatID = "other"
	if _, err := f.host.Ingest(f.ctx, input); err == nil {
		t.Fatal("unbound conversation accepted")
	}
	if err := f.host.DiscoverConversation(f.ctx, model.DiscoveredConversation{ChatID: "not-bound", SenderID: "alice"}); err != nil {
		t.Fatal(err)
	}
	discovered, err := f.runtime.Discoveries(f.ctx, "wechat", 50)
	if err != nil || len(discovered) != 2 {
		t.Fatalf("discovery: %#v %v", discovered, err)
	}
	input.Target.ChatID = "not-bound"
	if _, err := f.host.Ingest(f.ctx, input); err == nil {
		t.Fatal("discovery created an authorization binding")
	}
	if err := f.host.MountHTTP(model.HTTPRoute{Pattern: "/../escape", Handler: http.NotFoundHandler()}); err == nil {
		t.Fatal("route escaped account")
	}
	for range 2 {
		err := f.host.MountHTTP(model.HTTPRoute{Pattern: "/duplicate", Handler: http.NotFoundHandler()})
		if err == nil {
			continue
		}
		if err.Error() != "duplicate_route" {
			t.Fatal(err)
		}
		return
	}
	t.Fatal("duplicate route was accepted")
}

func TestMCPPendingCursorPagesWithoutRepeatingBoundary(t *testing.T) {
	f := newRelayFixture(t, core.Options{})
	record := awaitInbound(t, f.store, model.AttemptAccepted)
	for i := range 5 {
		input := model.IngestInput{Source: model.SourceKey{Channel: model.WeChat, AccountID: "wechat", EventID: fmt.Sprintf("page-%d", i)}, SenderID: "alice", Text: "pending", Target: record.Snapshot.Target, ReceivedAt: time.Now()}
		if _, err := f.host.Ingest(f.ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	session := connectMCP(t, f)
	seen := map[string]bool{}
	input := map[string]any{"pending": true, "limit": 2}
	for range 5 {
		page := callTool[struct {
			Messages []struct {
				RequestID  string `json:"requestId"`
				AcceptedAt int64  `json:"acceptedAt"`
			} `json:"messages"`
			Cursor any `json:"nextCursor"`
		}](t, f, session, "relanox_read_messages", input)
		for _, message := range page.Messages {
			if seen[message.RequestID] {
				t.Fatalf("cursor repeated %s", message.RequestID)
			}
			seen[message.RequestID] = true
		}
		if page.Cursor == nil {
			break
		}
		input["cursor"] = page.Cursor
	}
	if len(seen) != 6 {
		t.Fatalf("pending pages returned %d of 6 messages", len(seen))
	}
}
