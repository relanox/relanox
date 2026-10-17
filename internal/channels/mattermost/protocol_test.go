package mattermost

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	mm "github.com/mattermost/mattermost/server/public/model"
	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

const (
	botID           = "bbbbbbbbbbbbbbbbbbbbbbbbbb"
	userID          = "uuuuuuuuuuuuuuuuuuuuuuuuuu"
	roomID          = "cccccccccccccccccccccccccc"
	postID          = "pppppppppppppppppppppppppp"
	rootID          = "rrrrrrrrrrrrrrrrrrrrrrrrrr"
	fileID          = "ffffffffffffffffffffffffff"
	uploadedID      = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
	sentID          = "ssssssssssssssssssssssssss"
	connectionID    = "dddddddddddddddddddddddddd"
	newConnectionID = "hhhhhhhhhhhhhhhhhhhhhhhhhh"
	gapPostID       = "gggggggggggggggggggggggggg"
)

type nativePeer struct {
	t                 *testing.T
	connections       chan map[string]string
	posts             chan *mm.Post
	uploads           chan []byte
	downloadStarted   chan struct{}
	blockDownload     atomic.Bool
	blockPost         atomic.Bool
	postStarted       chan struct{}
	active            atomic.Int32
	changedUser       atomic.Bool
	resetConnection   atomic.Bool
	failHistory       atomic.Bool
	cappedHistory     atomic.Bool
	unboundPost       atomic.Bool
	createdAt         atomic.Int64
	replayBeforeStart atomic.Bool
	historyRequests   chan string
	historyFailures   atomic.Int32
	historySuccesses  atomic.Int32
}

// The peer serves only documented external native endpoints and socket frames.
// https://docs.mattermost.com/api/reference/mattermost-api
// https://docs.mattermost.com/api/reference/upload-file
// https://docs.mattermost.com/api/reference/create-post
// https://github.com/mattermost/mattermost/blob/master/server/public/model/websocket_client.go
// https://github.com/mattermost/mattermost/blob/master/server/channels/app/platform/web_conn.go
func (p *nativePeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Auth schemes are case-insensitive (RFC 9110 section 11.1); the official
	// Client4 uses BEARER while WebSocket upgrade headers use Bearer.
	scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(scheme, "Bearer") || token != "native-token" {
		p.t.Error("native credential missing")
		w.WriteHeader(401)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/v4/users/me":
		id := botID
		if p.changedUser.Load() {
			id = userID
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"id": id})
	case "/api/v4/websocket":
		p.socket(w, r)
	case "/api/v4/posts/" + postID + "/files/info":
		_ = json.NewEncoder(w).Encode([]any{map[string]any{"id": fileID, "post_id": postID, "name": "voice.ogg", "mime_type": "audio/ogg; codecs=opus", "size": 16}})
	case "/api/v4/files/" + fileID:
		if p.blockDownload.CompareAndSwap(true, false) {
			close(p.downloadStarted)
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "audio/ogg")
		_, _ = io.WriteString(w, "OggS-native-file")
	case "/api/v4/files":
		p.upload(w, r)
	case "/api/v4/posts":
		p.post(w, r)
	case "/api/v4/channels/" + roomID + "/posts":
		p.historyPage(w, r)
	default:
		p.t.Errorf("unexpected native endpoint %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

func (p *nativePeer) socket(w http.ResponseWriter, r *http.Request) {
	connection, err := websocket.Accept(w, r, nil)
	if err != nil {
		p.t.Error(err)
		return
	}
	defer func() { _ = connection.CloseNow() }()
	p.active.Add(1)
	defer p.active.Add(-1)
	ctx := r.Context()
	var challenge struct {
		Seq    int    `json:"seq"`
		Action string `json:"action"`
		Data   struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err = wsjson.Read(ctx, connection, &challenge); err != nil {
		return
	}
	if challenge.Seq != 1 || challenge.Action != "authentication_challenge" || challenge.Data.Token != "native-token" {
		p.t.Error("invalid native auth challenge")
		return
	}
	query := r.URL.Query()
	p.connections <- map[string]string{"connection_id": query.Get("connection_id"), "sequence_number": query.Get("sequence_number")}
	if wsjson.Write(ctx, connection, map[string]any{"status": "OK", "seq_reply": 1}) != nil {
		return
	}
	if !p.sendEvents(ctx, connection, query) {
		return
	}
	for {
		var request json.RawMessage
		if wsjson.Read(ctx, connection, &request) != nil {
			return
		}
	}
}

func (p *nativePeer) historyPage(w http.ResponseWriter, r *http.Request) {
	since := r.URL.Query().Get("since")
	p.historyRequests <- since
	if p.failHistory.Load() {
		p.historyFailures.Add(1)
		w.WriteHeader(503)
		_, _ = io.WriteString(w, `{"id":"native_failure"}`)
		return
	}
	// Native getPostsForChannel and Client4 both use collapsedThreads.
	// https://github.com/mattermost/mattermost/blob/master/server/channels/api4/post.go
	if r.URL.Query().Get("per_page") != "" || r.URL.Query().Get("collapsedThreads") != "false" || since == "" || r.URL.Query().Get("before") != "" {
		p.t.Error("unbounded or discontinuous history query")
	}
	key := "complete"
	if p.cappedHistory.Load() {
		key = "capped"
	}
	raw, ok := historyFixtures(p.createdAt.Load())[key]
	if !ok {
		p.t.Error("missing native history fixture")
		w.WriteHeader(400)
		return
	}
	_, _ = w.Write(raw)
	p.historySuccesses.Add(1)
}

func (p *nativePeer) upload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		p.t.Error(err)
		w.WriteHeader(400)
		return
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	file, header, err := r.FormFile("files")
	if err != nil {
		p.t.Error(err)
		w.WriteHeader(400)
		return
	}
	defer func() { _ = file.Close() }()
	raw, err := io.ReadAll(file)
	if err != nil || r.FormValue("channel_id") != roomID || header.Filename != "voice.ogg" || header.Header.Get("Content-Type") != "audio/ogg" {
		p.t.Errorf("native upload metadata: %+v %v", header, err)
	}
	p.uploads <- raw
	_ = json.NewEncoder(w).Encode(map[string]any{"file_infos": []any{map[string]string{"id": uploadedID}}})
}

func (p *nativePeer) post(w http.ResponseWriter, r *http.Request) {
	post := new(mm.Post)
	if json.NewDecoder(r.Body).Decode(post) != nil {
		p.t.Error("invalid native post")
	}
	p.posts <- post
	if p.blockPost.Load() {
		close(p.postStarted)
		<-r.Context().Done()
		return
	}
	w.WriteHeader(201)
	_ = json.NewEncoder(w).Encode(map[string]string{"id": sentID})
}

type fixture struct {
	store         *storage.Store
	runtime       *core.Runtime
	channel       *Channel
	host          model.ChannelHost
	scoped        model.ScopedAgentHost
	server        *httptest.Server
	cancel        context.CancelFunc
	notifications chan string
	peer          *nativePeer
}

func openFixture(t *testing.T, path string, peer *httptest.Server, recoveryEpoch ...string) *fixture {
	t.Helper()
	native, ok := peer.Config.Handler.(*nativePeer)
	if !ok {
		t.Fatal("fixture requires a native Mattermost peer")
	}
	notifications := make(chan string, 32)
	routine := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var envelope struct {
			Content string `json:"content"`
		}
		if json.NewDecoder(r.Body).Decode(&envelope) != nil {
			t.Error("invalid routine envelope")
			w.WriteHeader(400)
			return
		}
		var message struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(envelope.Content), &message) != nil {
			t.Error("invalid routine content")
			w.WriteHeader(400)
			return
		}
		notifications <- message.Text
		// Routine success receipt: https://cursor.com/help/grok-bot/routines#where-do-the-webhook-url-and-key-live-and-what-does-a-200-mean
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(routine.Close)
	server := httptest.NewUnstartedServer(nil)
	account := model.AccountConfig{ID: "mattermost", Channel: model.Mattermost, AllowedSenders: []string{userID}, Config: common.Data(Config{ServerURL: peer.URL, Token: model.SecretRef{Env: "TOKEN"}, AllowInsecureLocalhost: true})}
	if len(recoveryEpoch) > 0 {
		var native Config
		_ = json.Unmarshal(account.Config, &native)
		native.RecoveryEpoch = recoveryEpoch[0]
		account.Config = common.Data(native)
	}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Auth: "bearer", Token: model.SecretRef{Env: "MCP"}}, RoutineURL: model.SecretRef{Env: "ROUTINE"}, RoutineAuthorization: model.SecretRef{Env: "ROUTINE_AUTH"}})}
	// Keep the production idle-poll default: a 5ms override creates empty write
	// transactions that compete with native checkpoints on SQLite's connection.
	cfg, err := config.Decode(common.Data(config.Config{Accounts: []model.AccountConfig{account}, Endpoints: []model.EndpointConfig{endpoint}, Bindings: []model.Binding{{AccountID: account.ID, ChatID: roomID, ThreadID: rootID, EndpointID: endpoint.ID}}, Storage: config.Storage{Driver: "sqlite", Path: path}, HTTP: config.HTTP{PublicURL: "http://" + server.Listener.Addr().String()}, Queue: config.Queue{Concurrency: 1}}))
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{server: server, notifications: notifications, peer: native}
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
		return map[string]string{"TOKEN": "native-token", "MCP": "mcp-token", "ROUTINE": routine.URL, "ROUTINE_AUTH": "Bearer routine"}[ref.Env], nil
	}
	f.channel, err = New(f.host, account, common.Options{HTTPClient: peer.Client(), ResolveSecret: secret})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runtime.AttachChannel(account.ID, f.channel); err != nil {
		t.Fatal(err)
	}
	host, err := f.runtime.AgentHost(model.Grok)
	if err != nil {
		t.Fatal(err)
	}
	agent, err := grok.New(endpoint, agentmcp.Dependencies{Host: host, ResolveSecret: secret, HTTPClient: routine.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runtime.AttachAgent(endpoint.ID, agent); err != nil {
		t.Fatal(err)
	}
	f.scoped, err = host.ForPrincipal(context.Background(), model.Principal{Subject: "test", EndpointIDs: []string{endpoint.ID}})
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

func (f *fixture) close(t *testing.T) {
	t.Helper()
	if f.cancel == nil {
		return
	}
	f.cancel()
	f.cancel = nil
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := f.runtime.Close(ctx); err != nil {
		t.Error(err)
	}
	f.server.Close()
	_ = f.store.Close()
}

func receive[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("native peer timeout")
		var zero T
		return zero
	}
}

func awaitCursor(t *testing.T, f *fixture, next int64) cursor {
	t.Helper()
	return awaitNativeState(t, f, fmt.Sprintf("durable native cursor %d", next), func(value cursor) bool { return value.NextSequence == next })
}

// Protects native auth, string-encoded posted frames, file MIME parameters,
// root-thread replies and cancellation-safe reliable resume through real Core
// and SQLite. Advancing sequence before Ingest loses a post after a cancelled
// attachment download; requiring hello on resume rejects native retained queues.
// Existing HTTP-only tests cannot catch this. No production-only seam is added.
func TestNativeSocketDurableResumeAndFileReply(t *testing.T) {
	p := &nativePeer{t: t, connections: make(chan map[string]string, 10), posts: make(chan *mm.Post, 10), uploads: make(chan []byte, 10), downloadStarted: make(chan struct{}), postStarted: make(chan struct{})}
	p.blockDownload.Store(true)
	peer := httptest.NewServer(p)
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "mattermost.db")
	f := openFixture(t, path, peer)
	first := receive(t, p.connections)
	if first["connection_id"] != "" || first["sequence_number"] != "0" {
		t.Fatalf("first cursor: %+v", first)
	}
	receive(t, p.downloadStarted)
	saved := awaitCursor(t, f, 1)
	if saved.ConnectionID != connectionID {
		t.Fatalf("native connection: %+v", saved)
	}
	rows, err := f.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(rows) != 0 {
		t.Fatalf("incomplete attachment accepted: %d %v", len(rows), err)
	}
	f.close(t)
	f = openFixture(t, path, peer)
	second := receive(t, p.connections)
	if second["connection_id"] != connectionID || second["sequence_number"] != "1" {
		t.Fatalf("unaccepted post skipped: %+v", second)
	}
	awaitCursor(t, f, 2)
	rows, err = f.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(rows) != 1 {
		t.Fatalf("resumed durable source: %d %v", len(rows), err)
	}
	input := rows[0].Snapshot
	if input.Source.EventID != postID || input.Target.ThreadID != rootID || input.Target.ReplyToID != postID || input.ReceivedAt.UnixMilli() != p.createdAt.Load() || input.Text != "native input" {
		t.Fatalf("native source changed: %+v", input)
	}
	media, err := f.store.GetMedia(context.Background(), input.Channel.ID, input.Attachments[0].ID)
	if err != nil || media == nil || media.Reference.MIMEType != "audio/ogg" || string(media.Data) != "OggS-native-file" {
		t.Fatalf("native media: %+v %v", media, err)
	}
	assertSendAndIdentity(t, f, p, input, media)
	assertRichPublication(t, f, p, input)
	f.close(t)
	f = openFixture(t, path, peer)
	third := receive(t, p.connections)
	if third["sequence_number"] != "2" {
		t.Fatalf("accepted source replayed from wrong cursor: %+v", third)
	}
	assertCancelledPost(t, f, p, input.Target)
}

func assertRichPublication(t *testing.T, f *fixture, p *nativePeer, input model.InboundSnapshot) {
	t.Helper()
	upload := model.MediaUpload{Kind: model.Image, MIMEType: "image/png", FileName: "plot.png", Data: []byte("public-native-image")}
	ref, err := f.scoped.Media().Upload(context.Background(), input.Channel.ID, uuid.NewString(), upload)
	if err != nil {
		t.Fatal(err)
	}
	media, err := f.scoped.Media().Read(context.Background(), input.Channel.ID, ref.ID)
	if err != nil || media == nil {
		t.Fatalf("scoped media: %+v %v", media, err)
	}
	result, err := f.channel.Send(context.Background(), model.SendInput{ChannelID: input.Channel.ID, Target: input.Target, Chunk: model.DeliveryChunk{RichText: []model.RichTextPart{{Type: "text", Text: "**before**"}, {Type: "image", Media: ref, Label: "native image"}, {Type: "text", Text: "_after_"}}}, RichMedia: []model.StoredMedia{*media}})
	if err != nil || result.Status != model.Sent {
		t.Fatalf("native rich send: %+v %v", result, err)
	}
	post := receive(t, p.posts)
	prefix := "**before**\n\n![native image](<"
	value, ok := strings.CutPrefix(post.Message, prefix)
	value, ended := strings.CutSuffix(value, ">)\n\n_after_")
	if !ok || !ended {
		t.Fatalf("native ordered image markdown: %q", post.Message)
	}
	response, err := f.server.Client().Get(value)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || string(raw) != "public-native-image" {
		t.Fatalf("native image publication: %d %q %v", response.StatusCode, raw, err)
	}
}

func assertSendAndIdentity(t *testing.T, f *fixture, p *nativePeer, input model.InboundSnapshot, media *model.StoredMedia) {
	t.Helper()
	resolution, err := f.channel.Resolve(context.Background(), input.Channel, &input.Target)
	if err != nil || !resolution.Available {
		t.Fatalf("target resolution: %+v %v", resolution, err)
	}
	result, err := f.channel.Send(context.Background(), model.SendInput{Target: *resolution.Target, Reply: &model.ReplyReference{RequestID: input.RequestID, Kind: model.Final}, Chunk: model.DeliveryChunk{Text: "**native answer**", Media: &media.Reference}, Media: media})
	if err != nil || result.Status != model.Sent || result.Receipt.PlatformMessageID != sentID {
		t.Fatalf("native send: %+v %v", result, err)
	}
	if raw := receive(t, p.uploads); string(raw) != "OggS-native-file" {
		t.Fatalf("upload content: %q", raw)
	}
	post := receive(t, p.posts)
	if post.ChannelId != roomID || post.RootId != rootID || post.Message != "**native answer**" || len(post.FileIds) != 1 || post.FileIds[0] != uploadedID {
		t.Fatalf("native create contract: %+v", post)
	}
	p.changedUser.Store(true)
	f.channel.identities.Invalidate()
	resolution, err = f.channel.Resolve(context.Background(), input.Channel, &input.Target)
	if err != nil || resolution.Available {
		t.Fatalf("changed native identity accepted: %+v %v", resolution, err)
	}
	p.changedUser.Store(false)
	f.channel.identities.Invalidate()
}

func assertCancelledPost(t *testing.T, f *fixture, p *nativePeer, target model.ReplyTarget) {
	t.Helper()
	p.blockPost.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan model.SendResult, 1)
	go func() {
		result, _ := f.channel.Send(ctx, model.SendInput{Target: target, Chunk: model.DeliveryChunk{Text: "uncertain native send"}})
		done <- result
	}()
	receive(t, p.postStarted)
	cancel()
	result := receive(t, done)
	if result.Status != model.Unknown {
		t.Fatalf("transmitted cancellation retried blindly: %+v", result)
	}
}

// Offline validation must not permit credentials to an insecure remote server,
// query/fragment URLs, or ambiguous structural fields. Other adapter validation
// tests do not cover administrator-configured Mattermost server prefixes.
func TestOfflineServerConfiguration(t *testing.T) {
	for _, server := range []string{"http://mattermost.example", "https://mattermost.example?token=x", "https://user:pass@mattermost.example", "https://mattermost.example/#fragment", "https://mattermost.example/a/../b"} {
		if err := ValidateConfig(common.Data(Config{ServerURL: server, Token: model.SecretRef{Env: "TOKEN"}})); err == nil {
			t.Fatalf("unsafe native server accepted: %s", server)
		}
	}
	if err := ValidateConfig([]byte(`{"serverUrl":"https://mattermost.example/prefix","token":{"env":"TOKEN"},"unknown":true}`)); err == nil {
		t.Fatal("unknown config accepted")
	}
	parts, err := textParts(strings.Repeat("界", 17000))
	if err != nil || len(parts) < 2 {
		t.Fatal("native codepoint limit was not split")
	}
}

func textParts(value string) ([]string, error) {
	return (&Channel{}).SplitText(value, model.ReplyTarget{})
}

func (p *nativePeer) sendEvents(ctx context.Context, connection *websocket.Conn, query url.Values) bool {
	if query.Get("connection_id") == "" || (p.resetConnection.Load() && query.Get("connection_id") != newConnectionID) {
		id := connectionID
		if p.resetConnection.Load() {
			id = newConnectionID
		}
		if wsjson.Write(ctx, connection, map[string]any{"event": "hello", "seq": 0, "data": map[string]string{"connection_id": id}}) != nil {
			return false
		}
	}
	// A retained reliable stream can resume directly with posted, without hello.
	// The source event is not advanced when its preceding file download failed.
	if p.replayBeforeStart.Load() && query.Get("sequence_number") == "2" {
		for i, post := range []map[string]any{
			{"id": "oooooooooooooooooooooooooo", "channel_id": roomID, "user_id": userID, "root_id": rootID, "message": "prior unbound history", "type": "", "create_at": time.Now().Add(-24 * time.Hour).UnixMilli()},
			{"id": "tttttttttttttttttttttttttt", "channel_id": roomID, "user_id": userID, "root_id": rootID, "message": "current bound input", "type": "", "create_at": time.Now().UnixMilli()},
		} {
			if wsjson.Write(ctx, connection, map[string]any{"event": "posted", "seq": i + 2, "data": map[string]string{"post": string(common.Data(post))}}) != nil {
				return false
			}
		}
	}
	if query.Get("sequence_number") != "2" && !p.resetConnection.Load() {
		p.createdAt.CompareAndSwap(0, time.Now().UnixMilli())
		post := map[string]any{"id": postID, "channel_id": roomID, "user_id": userID, "root_id": rootID, "message": "native input", "type": "", "file_ids": []string{fileID}, "create_at": p.createdAt.Load()}
		if p.unboundPost.Load() {
			post["channel_id"] = "vvvvvvvvvvvvvvvvvvvvvvvvvv"
		}
		if wsjson.Write(ctx, connection, map[string]any{"event": "posted", "seq": 1, "data": map[string]string{"post": string(common.Data(post))}}) != nil {
			return false
		}
	}
	return true
}
