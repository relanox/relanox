package slack

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
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

// Native fixtures follow Slack's official Socket Mode, signing, media and Block
// Kit contracts and slack-go v0.30.1 native request/response models:
// https://docs.slack.dev/apis/events-api/using-socket-mode/
// https://docs.slack.dev/authentication/verifying-requests-from-slack/
// https://docs.slack.dev/messaging/working-with-files/
// https://slack.com/blog/developers/uploading-private-images-blockkit
// These tests protect durable acceptance before ACK, native message identity,
// private media retrieval, and the transfer/publication retry boundary. Existing
// generic Core tests cannot establish which Slack upload step can publish. All
// persistence and recovery use real Core/SQLite; peers implement only Slack.
// The acceptance fault uses the existing Storage interface, with no new seam.
type failingAcceptance struct {
	model.Storage
	fail     bool
	attempts chan struct{}
}

func (s *failingAcceptance) AcceptInbound(ctx context.Context, in model.InboundSnapshot, media []model.StoredMedia) (model.IngestReceipt, error) {
	if s.fail {
		select {
		case s.attempts <- struct{}{}:
		default:
		}
		return model.IngestReceipt{}, errors.New("storage_unavailable")
	}
	return s.Storage.AcceptInbound(ctx, in, media)
}

type slackRelay struct {
	channel *Channel
	host    model.ChannelHost
	store   *storage.Store
	runtime *core.Runtime
	scope   model.ScopedAgentHost
	cancel  context.CancelFunc
	routine *httptest.Server
	fault   *failingAcceptance
	closed  atomic.Bool
}

func startSlackRelay(t *testing.T, peer *httptest.Server, path string, fail, socket bool) *slackRelay {
	t.Helper()
	f := &slackRelay{}
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	t.Cleanup(func() { f.close(t) })
	f.routine = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.Copy(io.Discard, r.Body); w.WriteHeader(204) }))
	slackConfig := Config{BotToken: model.SecretRef{Env: "BOT"}, AppID: "A1", APIBaseURL: peer.URL}
	if socket {
		slackConfig.AppToken = &model.SecretRef{Env: "APP"}
	} else {
		slackConfig.SigningSecret = &model.SecretRef{Env: "SIGN"}
	}
	account := model.AccountConfig{ID: "slack", Channel: model.Slack, AllowedSenders: []string{"U1"}, Config: common.Data(slackConfig)}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Auth: "bearer", Token: model.SecretRef{Env: "MCP"}}, RoutineURL: model.SecretRef{Env: "ROUTINE"}, RoutineAuthorization: model.SecretRef{Env: "AUTH"}})}
	cfg := config.Config{Accounts: []model.AccountConfig{account}, Endpoints: []model.EndpointConfig{endpoint}, Bindings: []model.Binding{{AccountID: account.ID, ChatID: "C1", ThreadID: "1700000000.000001", EndpointID: endpoint.ID}}, Storage: config.Storage{Driver: "sqlite", Path: path}, HTTP: config.HTTP{PublicURL: "https://relay.example.org"}, Queue: config.Queue{Concurrency: 1, PollIntervalMS: 5}}
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
		return map[string]string{"BOT": "bot-token", "APP": "app-token", "SIGN": "signing-secret", "MCP": "mcp-token", "ROUTINE": f.routine.URL, "AUTH": "Bearer routine-token"}[ref.Env], nil
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
	attachSlackAgent(t, f, endpoint, secret)
	if err = f.runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func attachSlackAgent(t *testing.T, f *slackRelay, endpoint model.EndpointConfig, secret func(model.SecretRef) (string, error)) {
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
	f.scope, err = host.ForPrincipal(context.Background(), model.Principal{Subject: "verified-test-principal", EndpointIDs: []string{endpoint.ID}})
	if err != nil {
		t.Fatal(err)
	}
}

func (f *slackRelay) close(t *testing.T) {
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
	t                 *testing.T
	origin            string
	acks              chan string
	completions       chan url.Values
	posts             chan url.Values
	uploads           atomic.Int32
	transfers         atomic.Int32
	completed         atomic.Int32
	fileInfo          atomic.Int32
	transferFailure   atomic.Bool
	completionFailure atomic.Bool
}

func newNativePeer(t *testing.T) (*nativePeer, *httptest.Server) {
	t.Helper()
	p := &nativePeer{t: t, acks: make(chan string, 16), completions: make(chan url.Values, 16), posts: make(chan url.Values, 16)}
	server := httptest.NewTLSServer(http.HandlerFunc(p.serve))
	p.origin = server.URL
	return p, server
}

func (p *nativePeer) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/socket":
		p.socket(w, r)
	case strings.HasPrefix(r.URL.Path, "/upload/v1/"):
		p.transfer(w, r)
	case r.URL.Path == "/private/image.png":
		if r.Header.Get("Authorization") != "Bearer bot-token" {
			p.t.Error("private media lost bot auth")
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = io.WriteString(w, "image")
	case r.URL.Path == "/apps.connections.open":
		if r.Header.Get("Authorization") != "Bearer app-token" {
			p.t.Error("Socket Mode did not use app token")
		}
		_, _ = io.WriteString(w, `{"ok":true,"url":"`+strings.Replace(p.origin, "https:", "wss:", 1)+`/socket?ticket=native-ticket"}`)
	default:
		p.webAPI(w, r)
	}
}

func (p *nativePeer) webAPI(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		p.t.Error(err)
		w.WriteHeader(400)
		return
	}
	if r.Form.Get("token") != "bot-token" {
		p.t.Error("SDK native bot token missing")
	}
	switch r.URL.Path {
	case "/auth.test":
		_, _ = io.WriteString(w, `{"ok":true,"team_id":"T1","user_id":"UBOT","bot_id":"B1"}`)
	case "/bots.info":
		_, _ = io.WriteString(w, `{"ok":true,"bot":{"id":"B1","user_id":"UBOT","app_id":"A1","deleted":false}}`)
	case "/files.info":
		p.fileInfo.Add(1)
		if r.Form.Get("file") != "F1" {
			p.t.Error("native compact file ID changed")
		}
		_, _ = io.WriteString(w, `{"ok":true,"file":{"id":"F1","name":"photo.png","mimetype":"image/png","size":5,"url_private_download":"`+p.origin+`/private/image.png"}}`)
	case "/files.getUploadURLExternal":
		n := p.uploads.Add(1)
		_, _ = fmt.Fprintf(w, `{"ok":true,"file_id":"FUPLOAD%d","upload_url":"%s/upload/v1/%d"}`, n, p.origin, n)
	case "/files.completeUploadExternal":
		p.complete(w, r)
	case "/chat.postMessage":
		p.posts <- r.Form
		_, _ = io.WriteString(w, `{"ok":true,"channel":"C1","ts":"1700000001.000003"}`)
	default:
		p.t.Errorf("unexpected native API request %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

func (p *nativePeer) transfer(w http.ResponseWriter, r *http.Request) {
	p.transfers.Add(1)
	data, _ := io.ReadAll(r.Body)
	if r.Method != http.MethodPost || string(data) != "image" || r.Header.Get("Authorization") != "" {
		p.t.Error("signed raw-byte upload was changed or leaked token")
	}
	if p.transferFailure.CompareAndSwap(true, false) {
		w.WriteHeader(503)
		return
	}
	_, _ = io.WriteString(w, "OK - 5")
}

func (p *nativePeer) complete(w http.ResponseWriter, r *http.Request) {
	p.completed.Add(1)
	p.completions <- r.Form
	if p.completionFailure.Load() {
		w.WriteHeader(503)
		return
	}
	var files []map[string]string
	if json.Unmarshal([]byte(r.Form.Get("files")), &files) != nil {
		p.t.Error("native file completion missing IDs")
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "files": files})
}

func (p *nativePeer) socket(w http.ResponseWriter, r *http.Request) {
	socket, err := websocket.Accept(w, r, nil)
	if err != nil {
		p.t.Error(err)
		return
	}
	defer socket.CloseNow()
	ctx := r.Context()
	if socket.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","connection_info":{"app_id":"A1"}}`)) != nil {
		return
	}
	if socket.Write(ctx, websocket.MessageText, []byte(`{"type":"events_api","envelope_id":"native-envelope","retry_attempt":1,"payload":`+nativeFileEvent+`}`)) != nil {
		return
	}
	for {
		_, raw, err := socket.Read(ctx)
		if err != nil {
			return
		}
		var ack struct {
			EnvelopeID string `json:"envelope_id"`
		}
		if json.Unmarshal(raw, &ack) != nil || ack.EnvelopeID != "native-envelope" {
			p.t.Error("native envelope ACK mismatch")
			return
		}
		p.acks <- ack.EnvelopeID
	}
}

const nativeFileEvent = `{"type":"event_callback","team_id":"T1","api_app_id":"A1","event_id":"EvFile","event":{"type":"message","subtype":"file_share","user":"U1","channel":"C1","text":"native input","ts":"1700000000.000002","thread_ts":"1700000000.000001","files":[{"id":"F1","file_access":"check_file_info"}]}}`

func TestSocketAcknowledgesOnlyAfterCoreAcceptanceAndSQLiteReopen(t *testing.T) {
	p, peer := newNativePeer(t)
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "slack.db")
	first := startSlackRelay(t, peer, path, true, true)
	select {
	case <-first.fault.attempts:
	case <-time.After(5 * time.Second):
		t.Fatal("native event never reached real Core")
	}
	first.close(t)
	select {
	case ack := <-p.acks:
		t.Fatalf("failed acceptance was acknowledged: %s", ack)
	default:
	}
	last := startSlackRelay(t, peer, path, false, true)
	defer last.close(t)
	select {
	case <-p.acks:
	case <-time.After(5 * time.Second):
		t.Fatal("redelivered native event was not acknowledged")
	}
	records, err := last.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 {
		t.Fatalf("event lost or duplicated after recovery: %d %v", len(records), err)
	}
	in := records[0].Snapshot
	if in.Source.EventID != "EvFile" || in.Target.ThreadID != "1700000000.000001" || in.Text != "native input" || len(in.Attachments) != 1 || p.fileInfo.Load() < 2 {
		t.Fatalf("native message or compact media recovery: %+v", in)
	}
	media, err := last.store.GetMedia(context.Background(), in.Channel.ID, in.Attachments[0].ID)
	if err != nil || media == nil || string(media.Data) != "image" {
		t.Fatalf("native media was not persisted: %+v %v", media, err)
	}
	assertRichSend(t, last, p)
}

func assertRichSend(t *testing.T, f *slackRelay, p *nativePeer) {
	t.Helper()
	resolved, err := f.channel.Resolve(context.Background(), model.ChannelAddress{Platform: model.Slack, AccountID: "slack", ChatID: "C1", ThreadID: "1700000000.000001"}, nil)
	if err != nil || resolved.Target == nil {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	media := model.StoredMedia{Reference: model.MediaReference{ID: "media", Kind: model.Image, MIMEType: "image/png", FileName: "photo.png", Size: 5}, Data: []byte("image")}
	input := model.SendInput{Target: *resolved.Target, Chunk: model.DeliveryChunk{IdempotencyKey: "rich-send", RichText: []model.RichTextPart{{Type: "text", Text: "**first**"}, {Type: "image", Media: &media.Reference, Label: "photo"}, {Type: "text", Text: "last"}}}, RichMedia: []model.StoredMedia{media}}
	result, err := f.channel.Send(context.Background(), input)
	if err != nil || result.Status != model.Sent {
		t.Fatalf("native rich send: %+v %v", result, err)
	}
	completion := <-p.completions
	if completion.Get("channel_id") != "" || completion.Get("initial_comment") != "" {
		t.Fatalf("rich image was prematurely published: %+v", completion)
	}
	post := <-p.posts
	var blocks []map[string]any
	if json.Unmarshal([]byte(post.Get("blocks")), &blocks) != nil || len(blocks) != 3 {
		t.Fatalf("native blocks missing: %+v", post)
	}
	image, _ := blocks[1]["slack_file"].(map[string]any)
	if blocks[0]["type"] != "section" || blocks[1]["type"] != "image" || image["id"] != "FUPLOAD1" || blocks[2]["type"] != "section" || post.Get("thread_ts") != "1700000000.000001" {
		t.Fatalf("native rich image order or thread changed: %+v", post)
	}
}

func signedRequest(t *testing.T, client *http.Client, endpoint, body string, tamper bool) *http.Response {
	t.Helper()
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte("signing-secret"))
	_, _ = io.WriteString(mac, "v0:"+timestamp+":"+body)
	if tamper {
		body += " "
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", "v0="+hex.EncodeToString(mac.Sum(nil)))
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func TestSignedWebhookRejectsTamperingAndDeduplicatesMessageAndMention(t *testing.T) {
	_, peer := newNativePeer(t)
	defer peer.Close()
	f := startSlackRelay(t, peer, filepath.Join(t.TempDir(), "slack.db"), false, false)
	defer f.close(t)
	relay := httptest.NewServer(f.runtime.Handler())
	defer relay.Close()
	endpoint := relay.URL + "/channels/slack/slack/events"
	challenge := `{"type":"url_verification","challenge":"native-challenge"}`
	if response := signedRequest(t, relay.Client(), endpoint, challenge, true); response.StatusCode != 401 {
		t.Fatalf("tampered challenge: %d", response.StatusCode)
	}
	response := signedRequest(t, relay.Client(), endpoint, challenge, false)
	var result map[string]string
	if json.NewDecoder(response.Body).Decode(&result) != nil || result["challenge"] != "native-challenge" {
		t.Fatalf("native challenge: %+v", result)
	}
	for _, kind := range []string{"message", "app_mention"} {
		body := `{"type":"event_callback","team_id":"T1","api_app_id":"A1","event_id":"Ev` + kind + `","event":{"type":"` + kind + `","user":"U1","channel":"C1","text":"one native post","ts":"1700000000.000002","thread_ts":"1700000000.000001"}}`
		if response := signedRequest(t, relay.Client(), endpoint, body, false); response.StatusCode != 200 {
			t.Fatalf("native callback: %d", response.StatusCode)
		}
	}
	records, err := f.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 || records[0].Snapshot.Text != "one native post" {
		t.Fatalf("message and mention were duplicated: %d %v", len(records), err)
	}
}

func awaitOutbound(t *testing.T, f *slackRelay, id string, expected model.DeliveryStatus) *model.OutboundRecord {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		record, err := f.store.GetOutbound(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if record != nil && record.Status == expected {
			return record
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("durable delivery did not reach expected Slack outcome")
	return nil
}

func nativeMediaMessage(channel, key string) model.SendMessageInput {
	return model.SendMessageInput{Channel: channel, IdempotencyKey: key, Attachments: []model.AgentAttachment{{Upload: &model.MediaUpload{Kind: model.Image, MIMEType: "image/png", FileName: "photo.png", Data: []byte("image")}}}}
}

func queueNativeMedia(t *testing.T, f *slackRelay, input model.SendMessageInput) model.MessageReceipt {
	t.Helper()
	receipt, err := f.scope.SendMessage(context.Background(), input)
	if err != nil || receipt.Status != model.Queued {
		t.Fatalf("native media was not queued: %+v %v", receipt, err)
	}
	return receipt
}

func TestTransferRetriesAndUnknownPublicationSurviveSQLiteReopen(t *testing.T) {
	p, peer := newNativePeer(t)
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "slack.db")
	f := startSlackRelay(t, peer, path, false, false)
	status, err := f.scope.Status(context.Background(), model.StatusInput{})
	if err != nil || len(status.Channels) != 1 {
		t.Fatalf("configured channel unavailable: %+v %v", status, err)
	}
	channel := status.Channels[0].Channel.ID
	p.transferFailure.Store(true)
	receipt := queueNativeMedia(t, f, nativeMediaMessage(channel, "safe-transfer"))
	awaitOutbound(t, f, receipt.DeliveryID, model.DeliverySent)
	if p.transfers.Load() != 2 || p.completed.Load() != 1 {
		t.Fatalf("transfer was not safely retried before one publication: transfers=%d completions=%d", p.transfers.Load(), p.completed.Load())
	}
	completion := <-p.completions
	if completion.Get("channel_id") != "C1" || completion.Get("thread_ts") != "1700000000.000001" {
		t.Fatalf("native file share target lost: %+v", completion)
	}
	p.completionFailure.Store(true)
	uncertainInput := nativeMediaMessage(channel, "uncertain-publication")
	uncertain := queueNativeMedia(t, f, uncertainInput)
	awaitOutbound(t, f, uncertain.DeliveryID, model.DeliveryUnknown)
	f.close(t)
	last := startSlackRelay(t, peer, path, false, false)
	defer last.close(t)
	replay, err := last.scope.SendMessage(context.Background(), uncertainInput)
	if err != nil || replay.Status != model.Queued || !replay.Replay || replay.DeliveryID != uncertain.DeliveryID {
		t.Fatalf("unknown publication was replayed after reopen: %+v %v", replay, err)
	}
	awaitOutbound(t, last, uncertain.DeliveryID, model.DeliveryUnknown)
	if p.completed.Load() != 2 || p.transfers.Load() != 3 {
		t.Fatalf("uncertain completion was blindly retried: transfers=%d completions=%d", p.transfers.Load(), p.completed.Load())
	}
}
