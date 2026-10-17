package line

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type protocolHost struct {
	model.ChannelHost
	state    model.StateStore
	handler  http.Handler
	received []model.IngestInput
}

func (h *protocolHost) State() model.StateStore { return h.state }

func (h *protocolHost) MountHTTP(route model.HTTPRoute) error { h.handler = route.Handler; return nil }

func (h *protocolHost) MaxMediaBytes() int64 { return 1024 * 1024 }

func (h *protocolHost) PublicURL() string { return "https://relay.example" }

func (h *protocolHost) Media() model.ChannelMediaHost { return publications{} }

func (h *protocolHost) Ingest(_ context.Context, input model.IngestInput) (model.IngestReceipt, error) {
	h.received = append(h.received, input)
	return model.IngestReceipt{RequestID: "req"}, nil
}

type publications struct{}

func (publications) Publish(_ context.Context, channel, id string, _ time.Duration) (string, error) {
	return "https://relay.example/media/" + url.PathEscape(channel) + "/" + url.PathEscape(id), nil
}

type rewriteTransport struct{ base *url.URL }

func (t rewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	copy.URL.Scheme = t.base.Scheme
	copy.URL.Host = t.base.Host
	return http.DefaultTransport.RoundTrip(copy)
}

type fixture struct {
	store   *storage.Store
	host    *protocolHost
	channel *Channel
}

func openFixture(t *testing.T, path string, client *http.Client) fixture {
	t.Helper()
	store, err := storage.Open(context.Background(), config.Storage{Driver: "sqlite", Path: path}, nil)
	if err != nil {
		t.Fatal(err)
	}
	host := &protocolHost{state: store.State(model.StateNamespace{Component: "channel", OwnerID: "line"})}
	cfg := Config{ChannelSecret: model.SecretRef{Env: "SECRET"}, AccessToken: model.SecretRef{Env: "TOKEN"}}
	channel, err := New(host, model.AccountConfig{ID: "line", Channel: model.LINE, AllowedSenders: []string{"user"}, Config: common.Data(cfg)}, common.Options{HTTPClient: client, ResolveSecret: func(model.SecretRef) (string, error) { return "public-fixture", nil }})
	if err != nil {
		t.Fatal(err)
	}
	return fixture{store: store, host: host, channel: channel}
}

// Protects signed event/source IDs, native HTTP202 content preparation and the
// 24-hour retry-key contract across real SQLite reopen. Reissuing a fresh key
// duplicates accepted pushes; treating202 as media accepts an empty attachment.
// Other channel tests have neither LINE status nor retry headers. No new seam.
// https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
// https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
// https://developers.line.biz/en/reference/messaging-api/#get-content
func TestNativeReceiveAndRetryRecovery(t *testing.T) {
	ctx := context.Background()
	peerState := &linePeer{t: t}
	peer := httptest.NewServer(peerState)
	defer peer.Close()
	base, _ := url.Parse(peer.URL)
	client := &http.Client{Transport: rewriteTransport{base: base}}
	filename := filepath.Join(t.TempDir(), "line.db")
	fixture := openFixture(t, filename, client)
	body := `{"destination":"bot","events":[{"type":"message","webhookEventId":"01NATIVE-EVENT","source":{"type":"group","userId":"user","groupId":"group"},"message":{"id":"native-message","type":"audio","duration":1250,"contentProvider":{"type":"line"}}}]}`
	callWebhook(t, fixture.host.handler, body, "invalid", 401)
	callWebhook(t, fixture.host.handler, body, lineSignature(body), 200)
	if len(fixture.host.received) != 1 || peerState.content != 2 {
		t.Fatalf("native receive ingests=%d content=%d", len(fixture.host.received), peerState.content)
	}
	inbound := fixture.host.received[0]
	assertInbound(t, inbound)
	// Audio has no native quote token. Quote a text event as defined by the
	// official webhook schema, while retaining the separate audio/media checks.
	// https://github.com/line/line-openapi/blob/main/webhook.yml
	quotedBody := `{"destination":"bot","events":[{"type":"message","webhookEventId":"01TEXT-EVENT","source":{"type":"group","userId":"user","groupId":"group"},"message":{"id":"quoted-message","type":"text","text":"question","quoteToken":"native-quote"}}]}`
	callWebhook(t, fixture.host.handler, quotedBody, lineSignature(quotedBody), 200)
	if len(fixture.host.received) != 2 {
		t.Fatalf("native text ingests = %d", len(fixture.host.received))
	}
	quotedTarget := fixture.host.received[1].Target
	input := model.SendInput{Target: quotedTarget, Reply: &model.ReplyReference{RequestID: "req", Kind: model.Final}, Chunk: model.DeliveryChunk{Text: "**answer**", IdempotencyKey: "delivery"}}
	result, err := fixture.channel.Send(ctx, input)
	if err != nil || result.Status != model.Retryable {
		t.Fatalf("first send %+v %v", result, err)
	}
	if err = fixture.store.Close(); err != nil {
		t.Fatal(err)
	}
	fixture = openFixture(t, filename, client)
	defer fixture.store.Close()
	resolved, err := fixture.channel.Resolve(ctx, model.ChannelAddress{Platform: model.LINE, AccountID: "line", ChatID: "group"}, &quotedTarget)
	if err != nil || !resolved.Available {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	input.Target = *resolved.Target
	result, err = fixture.channel.Send(ctx, input)
	if err != nil || result.Status != model.Sent || result.Receipt == nil || !strings.Contains(string(result.Receipt.Data), "accepted-request") {
		t.Fatalf("accepted retry: %+v %v", result, err)
	}
	if len(peerState.keys) != 2 || peerState.keys[0] != peerState.keys[1] {
		t.Fatalf("retry identity changed: %+v", peerState.keys)
	}
	if _, err = uuid.Parse(peerState.keys[0]); err != nil {
		t.Fatalf("native retry UUID: %v", err)
	}
	assertRichAndIdentity(t, fixture.channel, inbound.Target, peerState)
	assertExpiredRetry(t, fixture, input, peerState)
}

func assertExpiredRetry(t *testing.T, fixture fixture, input model.SendInput, peer *linePeer) {
	t.Helper()
	ctx := context.Background()
	count := len(peer.keys)
	if !fixture.channel.Capabilities().IdempotentSend {
		t.Fatal("native retry capability hidden")
	}
	if err := common.SaveState(ctx, fixture.host.State(), "push:"+input.Chunk.IdempotencyKey, retryIdentity{Key: uuid.NewString(), StartedAt: time.Now().Add(-25 * time.Hour).UnixMilli()}, nil); err != nil {
		t.Fatal(err)
	}
	result, err := fixture.channel.Send(ctx, input)
	if err != nil || result.Status != model.Unknown || result.ErrorCode != "retry_key_expired" || len(peer.keys) != count {
		t.Fatalf("expired retry retransmitted: %+v %v", result, err)
	}
}

// A slow bot-info HTTP request must not trap a canceled concurrent Resolve on
// an ordinary mutex. Existing retry checks are serial and cannot catch this
// lifecycle regression. Uses only real HTTP blocking and production cancellation.
func TestCanceledResolveDoesNotWaitForIdentity(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		io.WriteString(w, `{"userId":"bot"}`)
	}))
	defer peer.Close()
	defer close(release)
	base, _ := url.Parse(peer.URL)
	client := &http.Client{Transport: rewriteTransport{base: base}}
	fixture := openFixture(t, filepath.Join(t.TempDir(), "cancel.db"), client)
	defer fixture.store.Close()
	address := model.ChannelAddress{Platform: model.LINE, AccountID: "line", ChatID: "group"}
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()
	firstDone := make(chan struct{})
	go func() { defer close(firstDone); _, _ = fixture.channel.Resolve(firstCtx, address, nil) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("identity request did not start")
	}
	secondCtx, cancelSecond := context.WithCancel(context.Background())
	cancelSecond()
	secondDone := make(chan error, 1)
	go func() { _, err := fixture.channel.Resolve(secondCtx, address, nil); secondDone <- err }()
	select {
	case err := <-secondDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Resolve cancellation: %v", err)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("canceled Resolve waited for unrelated HTTP")
	}
	cancelFirst()
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("identity HTTP did not cancel")
	}
}

func assertInbound(t *testing.T, input model.IngestInput) {
	t.Helper()
	if input.Source.EventID != "01NATIVE-EVENT" || input.Target.ChatID != "group" || input.Target.ReplyToID != "native-message" || input.SenderID != "user" {
		t.Fatalf("native IDs: %+v", input)
	}
	if len(input.Attachments) != 1 || string(input.Attachments[0].Data) != "m4a" || input.Attachments[0].DurationMS == nil || *input.Attachments[0].DurationMS != 1250 {
		t.Fatalf("native audio: %+v", input.Attachments)
	}
}

func assertRichAndIdentity(t *testing.T, channel *Channel, target model.ReplyTarget, peer *linePeer) {
	t.Helper()
	ctx := context.Background()
	media := model.StoredMedia{Reference: model.MediaReference{ID: "owned-image", Kind: model.Image, MIMEType: "image/png", FileName: "image.png", Size: 3}, Data: []byte("png")}
	parts := []model.RichTextPart{{Type: "text", Text: "**before**"}, {Type: "image", Media: &media.Reference, Label: "image"}, {Type: "text", Text: "after"}}
	result, err := channel.Send(ctx, model.SendInput{Target: target, ChannelID: "line/group", Chunk: model.DeliveryChunk{IdempotencyKey: "rich", RichText: parts}, RichMedia: []model.StoredMedia{media}})
	if err != nil || result.Status != model.Sent || !peer.rich {
		t.Fatalf("rich push: %+v %v", result, err)
	}
	changed := target
	changed.Data = common.Data(targetData{Destination: target.ChatID, BotID: "replacement", APIBaseURL: apiBase})
	resolved, err := channel.Resolve(ctx, model.ChannelAddress{Platform: model.LINE, AccountID: "line", ChatID: target.ChatID}, &changed)
	if err != nil || resolved.Available {
		t.Fatal("changed bot target accepted")
	}
	media.Reference.Kind = model.File
	result, err = channel.Send(ctx, model.SendInput{Target: target, Chunk: model.DeliveryChunk{IdempotencyKey: "unsupported-file", Media: &media.Reference}, Media: &media})
	if err != nil || result.ErrorCode != "native_file_send_unsupported" || len(peer.keys) != 3 {
		t.Fatalf("unsupported file: %+v %v", result, err)
	}
}

func lineSignature(body string) string {
	mac := hmac.New(sha256.New, []byte("public-fixture"))
	mac.Write([]byte(body))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func callWebhook(t *testing.T, handler http.Handler, body, signature string, want int) {
	t.Helper()
	request := httptest.NewRequest("POST", "/webhook", strings.NewReader(body))
	request.Header.Set("X-Line-Signature", signature)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != want {
		t.Fatalf("webhook %d want %d", response.Code, want)
	}
}

type linePeer struct {
	t       *testing.T
	content int
	keys    []string
	rich    bool
}

func (p *linePeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer public-fixture" {
		p.t.Error("LINE auth")
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/v2/bot/info":
		io.WriteString(w, `{"userId":"bot","basicId":"@fixture","displayName":"Fixture"}`)
	case "/v2/bot/message/native-message/content":
		p.content++
		if p.content == 1 {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "audio/mp4")
		io.WriteString(w, "m4a")
	case "/v2/bot/message/push":
		p.push(w, r)
	default:
		p.t.Errorf("unexpected LINE request %s", r.URL)
		w.WriteHeader(404)
	}
}

func (p *linePeer) push(w http.ResponseWriter, r *http.Request) {
	p.keys = append(p.keys, r.Header.Get("X-Line-Retry-Key"))
	var body struct {
		To       string                       `json:"to"`
		Messages []map[string]json.RawMessage `json:"messages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		p.t.Error(err)
		return
	}
	if body.To != "group" || len(body.Messages) != 1 {
		p.t.Error("LINE push destination")
		return
	}
	if len(p.keys) <= 2 {
		if string(body.Messages[0]["type"]) != `"text"` || string(body.Messages[0]["text"]) != `"answer"` || string(body.Messages[0]["quoteToken"]) != `"native-quote"` {
			p.t.Errorf("quoted native text: %+v", body.Messages[0])
		}
		if len(p.keys) == 1 {
			w.WriteHeader(503)
			io.WriteString(w, `{"message":"temporary"}`)
			return
		}
		w.Header().Set("X-Line-Accepted-Request-Id", "accepted-request")
		w.WriteHeader(409)
		io.WriteString(w, `{"message":"retry key accepted"}`)
		return
	}
	var flex struct {
		Body struct {
			Contents []map[string]json.RawMessage `json:"contents"`
		} `json:"body"`
	}
	if json.Unmarshal(body.Messages[0]["contents"], &flex) != nil || len(flex.Body.Contents) != 3 {
		p.t.Error("LINE rich body order")
		return
	}
	if string(flex.Body.Contents[1]["type"]) != `"image"` || !strings.Contains(string(flex.Body.Contents[1]["url"]), "owned-image") {
		p.t.Error("LINE rich image")
	}
	p.rich = true
	io.WriteString(w, `{"sentMessages":[{"id":"native-sent","quoteToken":"new-quote"}]}`)
}
