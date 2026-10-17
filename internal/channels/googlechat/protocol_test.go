package googlechat

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type googlePeer struct {
	t        *testing.T
	key      *rsa.PrivateKey
	sends    chan nativeSend
	mode     atomic.Int32
	started  chan struct{}
	requests atomic.Int32
}

type nativeSend struct {
	Payload     map[string]any
	RequestID   string
	ReplyOption string
}

// Wire fixtures follow Google's native (non-add-on) Chat event and REST contract.
// https://developers.google.com/workspace/chat/verify-requests-from-chat
// https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages
// https://developers.google.com/workspace/chat/api/reference/rest/v1/media/download
func (p *googlePeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/oauth2/v3/certs":
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "native-key", "n": base64.RawURLEncoding.EncodeToString(p.key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(p.key.E)).Bytes())}}})
	case "/token":
		p.oauth(w, r)
	case "/v1/media/spaces/space/messages/source/attachments/file":
		if r.Header.Get("Authorization") != "Bearer native-access-token" {
			p.t.Error("missing media authorization")
		}
		w.Header().Set("Content-Type", "audio/ogg")
		_, _ = w.Write([]byte("OggS-native-audio"))
	case "/v1/spaces/space/messages":
		p.send(w, r)
	default:
		p.t.Errorf("unexpected Google operation %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

func (p *googlePeer) oauth(w http.ResponseWriter, r *http.Request) {
	if r.ParseForm() != nil || r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
		p.t.Error("invalid OAuth grant")
	}
	token, err := jwt.Parse(r.Form.Get("assertion"), func(*jwt.Token) (any, error) { return &p.key.PublicKey, nil }, jwt.WithValidMethods([]string{"RS256"}), jwt.WithAudience("https://oauth2.googleapis.com/token"), jwt.WithIssuer("relay@project.iam.gserviceaccount.com"))
	if err != nil || !token.Valid {
		p.t.Errorf("invalid service-account assertion: %v", err)
	}
	claims, _ := token.Claims.(jwt.MapClaims)
	if claims["scope"] != "https://www.googleapis.com/auth/chat.bot" {
		p.t.Error("wrong OAuth scope")
	}
	_, _ = io.WriteString(w, `{"access_token":"native-access-token","token_type":"Bearer","expires_in":3600}`)
}

func (p *googlePeer) send(w http.ResponseWriter, r *http.Request) {
	p.requests.Add(1)
	if r.Header.Get("Authorization") != "Bearer native-access-token" {
		p.t.Error("missing send authorization")
	}
	var payload map[string]any
	if json.NewDecoder(r.Body).Decode(&payload) != nil {
		p.t.Error("invalid create body")
	}
	p.sends <- nativeSend{Payload: payload, RequestID: r.URL.Query().Get("requestId"), ReplyOption: r.URL.Query().Get("messageReplyOption")}
	if p.mode.Load() == 1 {
		close(p.started)
		<-r.Context().Done()
		return
	}
	_, _ = io.WriteString(w, `{"name":"spaces/space/messages/sent"}`)
}

type rewriteTransport struct {
	base *url.URL
	next http.RoundTripper
}

func (t rewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	copy.URL.Scheme = t.base.Scheme
	copy.URL.Host = t.base.Host
	return t.next.RoundTrip(copy)
}

type fixture struct {
	runtime *core.Runtime
	store   *storage.Store
	channel *Channel
	host    model.ChannelHost
	scoped  model.ScopedAgentHost
	server  *httptest.Server
	cancel  context.CancelFunc
}

func newFixture(t *testing.T, p *googlePeer, path string, client *http.Client) *fixture {
	t.Helper()
	routine := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		// Routine success receipt: https://cursor.com/help/grok-bot/routines#where-do-the-webhook-url-and-key-live-and-what-does-a-200-mean
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(routine.Close)
	server := httptest.NewUnstartedServer(nil)
	account := model.AccountConfig{ID: "google", Channel: model.GoogleChat, AllowedSenders: []string{"users/alice"}, Config: common.Data(Config{ServiceAccount: model.SecretRef{Env: "SERVICE_ACCOUNT"}})}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Auth: "bearer", Token: model.SecretRef{Env: "MCP"}}, RoutineURL: model.SecretRef{Env: "ROUTINE"}, RoutineAuthorization: model.SecretRef{Env: "ROUTINE_AUTH"}})}
	cfg, err := config.Decode(common.Data(config.Config{Accounts: []model.AccountConfig{account}, Endpoints: []model.EndpointConfig{endpoint}, Bindings: []model.Binding{{AccountID: "google", ChatID: "spaces/space", ThreadID: "spaces/space/threads/thread", EndpointID: "grok"}}, Storage: config.Storage{Driver: "sqlite", Path: path}, HTTP: config.HTTP{PublicURL: "http://" + server.Listener.Addr().String()}, Queue: config.Queue{Concurrency: 1, PollIntervalMS: 5}}))
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{server: server}
	f.store, err = storage.Open(context.Background(), cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.runtime, err = core.New(cfg, f.store, core.Options{})
	if err != nil {
		t.Fatal(err)
	}
	f.host, err = f.runtime.ChannelHost(account.ID)
	if err != nil {
		t.Fatal(err)
	}
	secret := func(ref model.SecretRef) (string, error) {
		if ref.Env == "SERVICE_ACCOUNT" {
			return serviceAccount(t, p.key), nil
		}
		return map[string]string{"MCP": "native-mcp", "ROUTINE": routine.URL, "ROUTINE_AUTH": "Bearer native-routine"}[ref.Env], nil
	}
	f.channel, err = New(f.host, account, common.Options{HTTPClient: client, ResolveSecret: secret})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runtime.AttachChannel(account.ID, f.channel); err != nil {
		t.Fatal(err)
	}
	agentHost, err := f.runtime.AgentHost(model.Grok)
	if err != nil {
		t.Fatal(err)
	}
	agent, err := grok.New(endpoint, agentmcp.Dependencies{Host: agentHost, ResolveSecret: secret, HTTPClient: routine.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runtime.AttachAgent(endpoint.ID, agent); err != nil {
		t.Fatal(err)
	}
	f.scoped, err = agentHost.ForPrincipal(context.Background(), model.Principal{Subject: "native-test", EndpointIDs: []string{"grok"}})
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = f.runtime.Handler()
	server.Start()
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	if err = f.runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.close(t) })
	return f
}

func serviceAccount(t *testing.T, key *rsa.PrivateKey) string {
	t.Helper()
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(common.Data(map[string]string{"type": "service_account", "client_email": "relay@project.iam.gserviceaccount.com", "private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded})), "token_uri": "https://evil.example/token"}))
}

func (f *fixture) close(t *testing.T) {
	t.Helper()
	if f.cancel == nil {
		return
	}
	f.cancel()
	f.cancel = nil
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.runtime.Close(ctx); err != nil {
		t.Error(err)
	}
	f.server.Close()
	_ = f.store.Close()
}

func (p *googlePeer) signed(t *testing.T, audience, issuer string) string {
	t.Helper()
	now := time.Now().Unix()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": issuer, "aud": audience, "iat": now, "exp": now + 3600, "email": "chat@system.gserviceaccount.com", "email_verified": true})
	token.Header["kid"] = "native-key"
	value, err := token.SignedString(p.key)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

const nativeEvent = `{"type":"MESSAGE","space":{"name":"spaces/space"},"message":{"name":"spaces/space/messages/source","text":"@bot visible text","argumentText":"native input","sender":{"name":"users/alice","type":"HUMAN"},"thread":{"name":"spaces/space/threads/thread"},"createTime":"2026-10-17T00:00:00Z","lastUpdateTime":"2026-10-17T00:00:01.123456789Z","attachment":[{"contentName":"voice.ogg","contentType":"audio/ogg","attachmentDataRef":{"resourceName":"spaces/space/messages/source/attachments/file"}}]}}`

func postEvent(t *testing.T, f *fixture, token, body string) int {
	t.Helper()
	r, _ := http.NewRequest(http.MethodPost, f.server.URL+"/channels/googlechat/google/webhook", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	response, err := f.server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode
}

// Protects cryptographic webhook identity, original nanosecond quote version,
// service-account OAuth and durable media/target recovery through real Core and
// SQLite. An issuer-only check, missing quote timestamp or rounded resource IDs
// would fail native authentication/reply. Other channel tests lack Google OIDC;
// all peers only speak external HTTP, without a new production seam.
func TestNativeOIDCInboundDurableQuoteAndMedia(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &googlePeer{t: t, key: key, sends: make(chan nativeSend, 10), started: make(chan struct{})}
	peer := httptest.NewServer(p)
	defer peer.Close()
	base, _ := url.Parse(peer.URL)
	client := &http.Client{Transport: rewriteTransport{base: base, next: peer.Client().Transport}}
	path := filepath.Join(t.TempDir(), "google.db")
	f := newFixture(t, p, path, client)
	input, media := acceptNativeEvent(t, f, p)
	f.close(t)
	f = newFixture(t, p, path, client)
	stored, err := f.store.GetInbound(context.Background(), input.RequestID)
	if err != nil || stored == nil {
		t.Fatal("source did not survive reopen")
	}
	resolution, err := f.channel.Resolve(context.Background(), stored.Snapshot.Channel, &stored.Snapshot.Target)
	if err != nil || !resolution.Available {
		t.Fatalf("recovered target: %+v %v", resolution, err)
	}
	result, err := f.channel.Send(context.Background(), model.SendInput{ChannelID: input.Channel.ID, Target: *resolution.Target, Reply: &model.ReplyReference{RequestID: input.RequestID, Kind: model.Final}, Chunk: model.DeliveryChunk{Text: "**native answer**", IdempotencyKey: "durable-chunk"}})
	if err != nil || result.Status != model.Sent {
		t.Fatalf("send: %+v %v", result, err)
	}
	first := <-p.sends
	quote, _ := first.Payload["quotedMessageMetadata"].(map[string]any)
	if first.ReplyOption != "REPLY_MESSAGE_OR_FAIL" || quote["name"] != "spaces/space/messages/source" || quote["lastUpdateTime"] != "2026-10-17T00:00:01.123456789Z" || first.Payload["markupSyntax"] != "MARKUP_SYNTAX_MARKDOWN" {
		t.Fatalf("native reply contract: %+v", first)
	}
	assertMediaCard(t, f, p, input, *resolution.Target, media)
	assertReplayAndCancel(t, f, p, input, *resolution.Target, first)
}

func assertMediaCard(t *testing.T, f *fixture, p *googlePeer, input model.InboundSnapshot, target model.ReplyTarget, media *model.StoredMedia) {
	t.Helper()
	result, err := f.channel.Send(context.Background(), model.SendInput{ChannelID: input.Channel.ID, Target: target, Chunk: model.DeliveryChunk{Media: &media.Reference, IdempotencyKey: "audio-card"}, Media: media})
	if err != nil || result.Status != model.Sent {
		t.Fatalf("media card: %+v %v", result, err)
	}
	message := <-p.sends
	cards, _ := message.Payload["cardsV2"].([]any)
	if len(cards) != 1 {
		t.Fatalf("missing native card: %+v", message.Payload)
	}
	card := cards[0].(map[string]any)["card"].(map[string]any)
	sections := card["sections"].([]any)
	widgets := sections[0].(map[string]any)["widgets"].([]any)
	buttons := widgets[0].(map[string]any)["buttonList"].(map[string]any)["buttons"].([]any)
	button := buttons[0].(map[string]any)
	value := button["onClick"].(map[string]any)["openLink"].(map[string]any)["url"].(string)
	response, err := f.server.Client().Get(value)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || string(raw) != "OggS-native-audio" || button["text"] != "voice.ogg" {
		t.Fatalf("published card asset: %d %q %v", response.StatusCode, raw, err)
	}
}

func assertReplayAndCancel(t *testing.T, f *fixture, p *googlePeer, input model.InboundSnapshot, target model.ReplyTarget, first nativeSend) {
	t.Helper()
	message := model.SendInput{ChannelID: input.Channel.ID, Target: target, Reply: &model.ReplyReference{RequestID: input.RequestID, Kind: model.Final}, Chunk: model.DeliveryChunk{Text: "**native answer**", IdempotencyKey: "durable-chunk"}}
	if result, err := f.channel.Send(context.Background(), message); err != nil || result.Status != model.Sent {
		t.Fatalf("replay: %+v %v", result, err)
	}
	second := <-p.sends
	if first.RequestID == "" || first.RequestID != second.RequestID {
		t.Fatal("native idempotency key changed")
	}
	p.mode.Store(1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan model.SendResult, 1)
	go func() { result, _ := f.channel.Send(ctx, message); done <- result }()
	select {
	case <-p.started:
	case <-time.After(3 * time.Second):
		t.Fatal("native send not reached")
	}
	cancel()
	select {
	case result := <-done:
		if result.Status != model.Unknown {
			t.Fatalf("cancelled transmitted send: %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("send ignored cancellation")
	}
}

func acceptNativeEvent(t *testing.T, f *fixture, p *googlePeer) (model.InboundSnapshot, *model.StoredMedia) {
	t.Helper()
	audience := f.server.URL + "/channels/googlechat/google/webhook"
	if status := postEvent(t, f, p.signed(t, audience, "https://evil.example"), nativeEvent); status != 401 {
		t.Fatalf("issuer accepted: %d", status)
	}
	if status := postEvent(t, f, p.signed(t, "https://wrong.example", "https://accounts.google.com"), nativeEvent); status != 401 {
		t.Fatalf("wrong audience: %d", status)
	}
	token := p.signed(t, audience, "https://accounts.google.com")
	if status := postEvent(t, f, token, nativeEvent); status != 200 {
		t.Fatalf("webhook: %d", status)
	}
	if status := postEvent(t, f, token, nativeEvent); status != 200 {
		t.Fatalf("duplicate: %d", status)
	}
	rows, err := f.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(rows) != 1 {
		t.Fatalf("durable dedup: %d %v", len(rows), err)
	}
	input := rows[0].Snapshot
	if input.Text != "native input" || input.Source.EventID != "spaces/space/messages/source" || len(input.Attachments) != 1 {
		t.Fatalf("native source lost: %+v", input)
	}
	media, err := f.store.GetMedia(context.Background(), input.Channel.ID, input.Attachments[0].ID)
	if err != nil || string(media.Data) != "OggS-native-audio" {
		t.Fatalf("durable native media: %+v %v", media, err)
	}
	return input, media
}
