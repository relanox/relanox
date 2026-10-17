package discord

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// Fixtures follow the native Gateway and message contracts, including current
// Identify properties and regional resume URLs:
// https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx
// https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway-events.mdx
// https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx
// These tests protect accept-before-checkpoint recovery, real thread routing and
// persisted media, native multipart/quote/nonce and rate-limit response handling.
// SDK-only or fake-host tests cannot catch the Core/storage integration failure.
// A fault at the existing Storage boundary leaves all successful persistence to
// real SQLite and introduces no production-only seam. Peers emulate only Discord.
type failingAcceptance struct {
	model.Storage
	fail     bool
	attempts chan struct{}
	accepted atomic.Int32
}

func (s *failingAcceptance) AcceptInbound(ctx context.Context, in model.InboundSnapshot, media []model.StoredMedia) (model.IngestReceipt, error) {
	if s.fail {
		select {
		case s.attempts <- struct{}{}:
		default:
		}
		return model.IngestReceipt{}, errors.New("storage_unavailable")
	}
	receipt, err := s.Storage.AcceptInbound(ctx, in, media)
	if err == nil && !receipt.Duplicate {
		s.accepted.Add(1)
	}
	return receipt, err
}

type discordRelay struct {
	channel *Channel
	host    model.ChannelHost
	store   *storage.Store
	runtime *core.Runtime
	cancel  context.CancelFunc
	routine *httptest.Server
	fault   *failingAcceptance
	closed  atomic.Bool
}

type fixtureOptions struct {
	Epoch    string
	Bindings []model.Binding
}

func startDiscordRelay(t *testing.T, peer *httptest.Server, path string, fail bool, options ...fixtureOptions) *discordRelay {
	t.Helper()
	f := &discordRelay{}
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	t.Cleanup(func() { f.close(t) })
	f.routine = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.Copy(io.Discard, r.Body); w.WriteHeader(204) }))
	nativeConfig := Config{BotToken: model.SecretRef{Env: "DISCORD_TOKEN"}, APIBaseURL: peer.URL}
	if len(options) > 0 {
		nativeConfig.RecoveryEpoch = options[0].Epoch
	}
	account := model.AccountConfig{ID: "discord", Channel: model.Discord, AllowedSenders: []string{"200"}, Config: common.Data(nativeConfig)}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Auth: "bearer", Token: model.SecretRef{Env: "MCP"}}, RoutineURL: model.SecretRef{Env: "ROUTINE"}, RoutineAuthorization: model.SecretRef{Env: "AUTH"}})}
	cfg := config.Config{Accounts: []model.AccountConfig{account}, Endpoints: []model.EndpointConfig{endpoint}, Bindings: []model.Binding{{AccountID: account.ID, ChatID: "400", ThreadID: "300", EndpointID: endpoint.ID}}, Storage: config.Storage{Driver: "sqlite", Path: path}, HTTP: config.HTTP{PublicURL: "https://relay.example.org"}, Queue: config.Queue{Concurrency: 1, PollIntervalMS: 5}}
	if len(options) > 0 && options[0].Bindings != nil {
		cfg.Bindings = options[0].Bindings
	}
	var err error
	f.store, err = storage.Open(ctx, cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.fault = &failingAcceptance{Storage: f.store, fail: fail, attempts: make(chan struct{}, 1)}
	f.runtime, err = core.New(cfg, f.fault, core.Options{})
	if err != nil {
		t.Fatal(err)
	}
	f.host, err = f.runtime.ChannelHost(account.ID)
	if err != nil {
		t.Fatal(err)
	}
	secret := func(ref model.SecretRef) (string, error) {
		return map[string]string{"DISCORD_TOKEN": "native-token", "MCP": "mcp-token", "ROUTINE": f.routine.URL, "AUTH": "Bearer routine-token"}[ref.Env], nil
	}
	pool := x509.NewCertPool()
	pool.AddCert(peer.Certificate())
	f.channel, err = New(f.host, account, common.Options{ResolveSecret: secret, TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runtime.AttachChannel(account.ID, f.channel); err != nil {
		t.Fatal(err)
	}
	attachDiscordAgent(t, f, endpoint, secret)
	if err = f.runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func attachDiscordAgent(t *testing.T, f *discordRelay, endpoint model.EndpointConfig, secret func(model.SecretRef) (string, error)) {
	t.Helper()
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
}

func (f *discordRelay) close(t *testing.T) {
	t.Helper()
	if !f.closed.CompareAndSwap(false, true) {
		return
	}
	f.cancel()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if f.runtime != nil {
		if err := f.runtime.Close(ctx); err != nil {
			t.Error(err)
		}
	}
	f.routine.Close()
	if f.store != nil {
		if err := f.store.Close(); err != nil {
			t.Error(err)
		}
	}
}

type nativePeer struct {
	t           *testing.T
	origin      string
	identifies  chan map[string]any
	sends       chan map[string]any
	rateLimited atomic.Bool
}

func (p *nativePeer) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path != "/gateway" && r.URL.Path != "/cdn/image.png" && r.Header.Get("Authorization") != "Bot native-token" {
		p.t.Error("native REST auth missing")
	}
	switch r.URL.Path {
	case "/users/@me":
		_, _ = io.WriteString(w, `{"id":"100","bot":true}`)
	case "/gateway/bot":
		_, _ = io.WriteString(w, `{"url":"`+strings.Replace(p.origin, "https:", "wss:", 1)+`/gateway"}`)
	case "/channels/300":
		_, _ = io.WriteString(w, `{"id":"300","type":11,"parent_id":"400","guild_id":"500"}`)
	case "/cdn/image.png":
		w.Header().Set("Content-Type", "image/png")
		_, _ = io.WriteString(w, "image")
	case "/gateway":
		p.gateway(w, r)
	case "/channels/300/messages":
		p.send(w, r)
	default:
		p.t.Errorf("unexpected native request %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

func (p *nativePeer) gateway(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("v") != "10" || r.URL.Query().Get("encoding") != "json" || r.URL.Query().Get("compress") != "" {
		p.t.Error("gateway lost native API version or encoding")
	}
	socket, err := websocket.Accept(w, r, nil)
	if err != nil {
		p.t.Error(err)
		return
	}
	defer socket.CloseNow()
	ctx := r.Context()
	if socket.Write(ctx, websocket.MessageText, []byte(`{"op":10,"d":{"heartbeat_interval":100}}`)) != nil {
		return
	}
	_, raw, err := socket.Read(ctx)
	if err != nil {
		return
	}
	var envelope struct {
		Op   int            `json:"op"`
		Data map[string]any `json:"d"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		p.t.Error("invalid gateway identify")
		return
	}
	p.identifies <- envelope.Data
	resumeURL := strings.Replace(p.origin, "https:", "wss:", 1) + "/gateway"
	if envelope.Op == 2 {
		properties, _ := envelope.Data["properties"].(map[string]any)
		if properties["os"] != "linux" || properties["browser"] != "relanox" || properties["$os"] != nil {
			p.t.Error("obsolete native Identify properties")
		}
		_ = socket.Write(ctx, websocket.MessageText, []byte(`{"op":0,"s":0,"t":"READY","d":{"v":10,"session_id":"native-session","resume_gateway_url":"`+resumeURL+`","user":{"id":"100","bot":true}}}`))
	} else if envelope.Op != 6 || envelope.Data["session_id"] != "native-session" || envelope.Data["seq"] != float64(0) {
		p.t.Errorf("resume skipped failed acceptance: %+v", envelope)
	}
	message := `{"op":0,"s":1,"t":"MESSAGE_CREATE","d":{"id":"600","channel_id":"300","guild_id":"500","type":0,"author":{"id":"200","bot":false},"content":"native input","timestamp":"2026-10-17T00:00:00.000Z","attachments":[{"id":"700","filename":"photo.png","size":5,"content_type":"image/png","url":"` + p.origin + `/cdn/image.png"}]}}`
	if socket.Write(ctx, websocket.MessageText, []byte(message)) != nil {
		return
	}
	if envelope.Op == 6 {
		_ = socket.Write(ctx, websocket.MessageText, []byte(`{"op":0,"s":2,"t":"RESUMED","d":{}}`))
	}
	p.heartbeat(ctx, socket)
}

func (p *nativePeer) heartbeat(ctx context.Context, socket *websocket.Conn) {
	for {
		_, raw, err := socket.Read(ctx)
		if err != nil {
			return
		}
		var envelope struct {
			Op int `json:"op"`
		}
		if json.Unmarshal(raw, &envelope) != nil || envelope.Op != 1 {
			p.t.Error("unexpected gateway client operation")
			return
		}
		if socket.Write(ctx, websocket.MessageText, []byte(`{"op":11,"d":null}`)) != nil {
			return
		}
	}
}

func (p *nativePeer) send(w http.ResponseWriter, r *http.Request) {
	if p.rateLimited.Load() {
		w.WriteHeader(429)
		_, _ = io.WriteString(w, `{"message":"rate limited","retry_after":1.25,"global":false}`)
		return
	}
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		p.t.Error(err)
		w.WriteHeader(400)
		return
	}
	var payload map[string]any
	if json.Unmarshal([]byte(r.FormValue("payload_json")), &payload) != nil {
		p.t.Error("native multipart payload missing")
	}
	file, header, err := r.FormFile("files[0]")
	if err != nil {
		p.t.Error(err)
		w.WriteHeader(400)
		return
	}
	defer file.Close()
	data, _ := io.ReadAll(file)
	if string(data) != "image" || header.Header.Get("Content-Type") != "image/png" {
		p.t.Error("native attachment bytes or MIME changed")
	}
	p.sends <- payload
	_, _ = io.WriteString(w, `{"id":"800","channel_id":"300"}`)
}

func discordCheckpoint(t *testing.T, f *discordRelay) gatewayState {
	t.Helper()
	state, err := readDiscordCheckpoint(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func readDiscordCheckpoint(ctx context.Context, f *discordRelay) (gatewayState, error) {
	key := "gateway:" + string(common.Data([]string{f.channel.config.APIBaseURL, "100"}))
	state, _, err := common.ReadState[gatewayState](ctx, f.host.State(), key)
	return state, err
}

func TestGatewayReplaysFailedAcceptanceAfterSQLiteReopen(t *testing.T) {
	p := &nativePeer{t: t, identifies: make(chan map[string]any, 8), sends: make(chan map[string]any, 8)}
	peer := httptest.NewTLSServer(http.HandlerFunc(p.serve))
	p.origin = peer.URL
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "discord.db")
	first := startDiscordRelay(t, peer, path, true)
	select {
	case <-first.fault.attempts:
	case <-time.After(5 * time.Second):
		t.Fatal("native message never reached real Core")
	}
	if state := discordCheckpoint(t, first); state.Sequence == nil || *state.Sequence != 0 || state.SessionID != "native-session" {
		t.Fatalf("failed acceptance advanced native sequence: %+v", state)
	}
	first.close(t)
	last := startDiscordRelay(t, peer, path, false)
	defer last.close(t)
	deadline := time.Now().Add(5 * time.Second)
	for !hasSequence(discordCheckpoint(t, last), 2) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !hasSequence(discordCheckpoint(t, last), 2) {
		t.Fatal("resumed sequence was not durably accepted")
	}
	records, err := last.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 {
		t.Fatalf("replayed message lost or duplicated: %d %v", len(records), err)
	}
	in := records[0].Snapshot
	if in.Target.ChatID != "400" || in.Target.ThreadID != "300" || in.Endpoint.ID != "grok" || in.Source.EventID != "600" || in.Text != "native input" || len(in.Attachments) != 1 {
		t.Fatalf("native thread/routing/media mismatch: %+v", in)
	}
	media, err := last.store.GetMedia(context.Background(), in.Channel.ID, in.Attachments[0].ID)
	if err != nil || media == nil || string(media.Data) != "image" {
		t.Fatalf("native media was not persisted: %+v %v", media, err)
	}
	assertDiscordSend(t, last, p)
}

func hasSequence(state gatewayState, expected int64) bool {
	return state.Sequence != nil && *state.Sequence == expected
}

func assertDiscordSend(t *testing.T, f *discordRelay, p *nativePeer) {
	t.Helper()
	resolved, err := f.channel.Resolve(context.Background(), model.ChannelAddress{Platform: model.Discord, AccountID: "discord", ChatID: "400", ThreadID: "300"}, nil)
	if err != nil || !resolved.Available || resolved.Target == nil {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	target := *resolved.Target
	target.ReplyToID = "600"
	media := model.StoredMedia{Reference: model.MediaReference{ID: "media", Kind: model.Image, MIMEType: "image/png", FileName: "photo.png", Size: 5}, Data: []byte("image")}
	input := model.SendInput{Target: target, Reply: &model.ReplyReference{RequestID: "request", Kind: model.Final}, Chunk: model.DeliveryChunk{Text: "native **reply**", IdempotencyKey: "transaction", Media: &media.Reference}, Media: &media}
	result, err := f.channel.Send(context.Background(), input)
	if err != nil || result.Status != model.Sent {
		t.Fatalf("native send: %+v %v", result, err)
	}
	payload := <-p.sends
	reference, _ := payload["message_reference"].(map[string]any)
	mentions, _ := payload["allowed_mentions"].(map[string]any)
	parse, parsePresent := mentions["parse"].([]any)
	nonce, _ := payload["nonce"].(string)
	if reference["message_id"] != "600" || !parsePresent || len(parse) != 0 || mentions["replied_user"] != false || len(nonce) != 25 || payload["enforce_nonce"] != true {
		t.Fatalf("native quote, mentions or nonce: %+v", payload)
	}
	p.rateLimited.Store(true)
	result, err = f.channel.Send(context.Background(), input)
	if err != nil || result.Status != model.Retryable || result.RetryAfter != 1250*time.Millisecond {
		t.Fatalf("native fractional retry_after: %+v %v", result, err)
	}
}
