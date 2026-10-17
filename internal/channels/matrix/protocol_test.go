package matrix

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

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// Native fixtures follow the Matrix client-server API and mautrix v0.32.0
// RespSync/RespMessages/MessageEventContent, not the relay implementation:
// https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3sync
// https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3roomsroomidmessages
// https://spec.matrix.org/v1.18/client-server-api/#transaction-identifiers
// These tests protect durable acceptance before cursor advancement, limited
// timeline recovery, native media/thread/transaction formats and fail-closed
// encryption. Adapter-only tests cannot catch storage/authorization integration
// failures. The storage fault uses the existing production Storage boundary; no
// production seam is added, and all successful persistence uses real SQLite.
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
		return model.IngestReceipt{}, errors.New("sqlite_unavailable")
	}
	return s.Storage.AcceptInbound(ctx, in, media)
}

type matrixRelay struct {
	channel *Channel
	host    model.ChannelHost
	store   *storage.Store
	runtime *core.Runtime
	cancel  context.CancelFunc
	routine *httptest.Server
	fault   *failingAcceptance
	closed  atomic.Bool
}

func startMatrixRelay(t *testing.T, peer *httptest.Server, path string, fail bool) *matrixRelay {
	t.Helper()
	f := &matrixRelay{}
	t.Cleanup(func() { f.close(t) })
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	f.routine = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	account := model.AccountConfig{ID: "matrix", Channel: model.Matrix, AllowedSenders: []string{"@alice:example.org"}, Config: common.Data(Config{Homeserver: peer.URL, AccessToken: model.SecretRef{Env: "MATRIX_TOKEN"}})}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Auth: "bearer", Token: model.SecretRef{Env: "MCP_TOKEN"}}, RoutineURL: model.SecretRef{Env: "ROUTINE"}, RoutineAuthorization: model.SecretRef{Env: "ROUTINE_AUTH"}})}
	cfg := config.Config{Accounts: []model.AccountConfig{account}, Endpoints: []model.EndpointConfig{endpoint}, Bindings: []model.Binding{{AccountID: account.ID, ChatID: "!room:example.org", ThreadID: "$thread", EndpointID: endpoint.ID}}, Storage: config.Storage{Driver: "sqlite", Path: path}, HTTP: config.HTTP{PublicURL: "https://relay.example.org"}, Queue: config.Queue{Concurrency: 1, PollIntervalMS: 5}}
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
		return map[string]string{"MATRIX_TOKEN": "native-token", "MCP_TOKEN": "mcp-token", "ROUTINE": f.routine.URL, "ROUTINE_AUTH": "Bearer routine-token"}[ref.Env], nil
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
	attachMatrixAgent(t, f, endpoint, secret)
	if err = f.runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func attachMatrixAgent(t *testing.T, f *matrixRelay, endpoint model.EndpointConfig, secret func(model.SecretRef) (string, error)) {
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

func (f *matrixRelay) close(t *testing.T) {
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

const anchorEvent = `{"event_id":"$anchor","type":"m.room.message","sender":"@alice:example.org","origin_server_ts":1700000000000,"content":{"msgtype":"m.text","body":"original","m.relates_to":{"rel_type":"m.thread","event_id":"$thread"}}}`
const middleEvent = `{"event_id":"$middle","type":"m.room.message","sender":"@alice:example.org","origin_server_ts":1700000000001,"content":{"msgtype":"m.text","body":"backfilled","m.relates_to":{"rel_type":"m.thread","event_id":"$thread"}}}`
const latestEvent = `{"event_id":"$latest","type":"m.room.message","sender":"@alice:example.org","origin_server_ts":1700000000002,"content":{"msgtype":"m.image","body":"photo.png","url":"mxc://example.org/media-id","info":{"mimetype":"image/png","size":3},"m.relates_to":{"rel_type":"m.thread","event_id":"$thread"}}}`

func syncJSON(cursor, timeline string, limited bool) string {
	return `{"next_batch":"` + cursor + `","rooms":{"join":{"!room:example.org":{"state":{"events":[]},"timeline":{"limited":` + map[bool]string{true: "true", false: "false"}[limited] + `,"prev_batch":"gap-start","events":[` + timeline + `]}}}}}`
}

func matrixState(t *testing.T, f *matrixRelay) checkpoint {
	t.Helper()
	key := "sync:" + string(common.Data([]string{f.channel.config.Homeserver, "@bot:example.org"}))
	value, _, err := common.ReadState[checkpoint](context.Background(), f.host.State(), key)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func awaitMatrixCursor(t *testing.T, f *matrixRelay, cursor string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if matrixState(t, f).Since == cursor {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("Matrix cursor did not reach durable acceptance")
}

func TestLimitedTimelineRecoveryUsesRealCoreAndSQLite(t *testing.T) {
	var recovery atomic.Bool
	peer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer native-token" {
			t.Error("native request lost authorization")
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/account/whoami"):
			_, _ = io.WriteString(w, `{"user_id":"@bot:example.org","device_id":"DEVICE"}`)
		case strings.HasSuffix(r.URL.Path, "/sync"):
			serveMatrixSync(w, r, recovery.Load())
		case strings.HasSuffix(r.URL.Path, "/messages"):
			if r.URL.Query().Get("dir") != "b" || r.URL.Query().Get("from") != "gap-start" {
				t.Error("missing native backward pagination")
			}
			_, _ = io.WriteString(w, `{"start":"gap-start","end":"older","chunk":[`+middleEvent+`,`+anchorEvent+`]}`)
		case strings.Contains(r.URL.Path, "/media/download/example.org/media-id"):
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte{1, 2, 3})
		default:
			t.Errorf("unexpected native request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "matrix.db")
	first := startMatrixRelay(t, peer, path, false)
	awaitMatrixCursor(t, first, "old-cursor")
	first.close(t)
	recovery.Store(true)
	failed := startMatrixRelay(t, peer, path, true)
	select {
	case <-failed.fault.attempts:
	case <-time.After(5 * time.Second):
		t.Fatal("backfilled event did not reach real core acceptance")
	}
	if state := matrixState(t, failed); state.Since != "old-cursor" || state.Rooms["!room:example.org"].LastEventID != "$anchor" {
		t.Fatalf("failed acceptance advanced checkpoint: %+v", state)
	}
	failed.close(t)
	last := startMatrixRelay(t, peer, path, false)
	defer last.close(t)
	awaitMatrixCursor(t, last, "new-cursor")
	assertMatrixRecovery(t, last)
}

func serveMatrixSync(w http.ResponseWriter, r *http.Request, recovery bool) {
	switch r.URL.Query().Get("since") {
	case "":
		_, _ = io.WriteString(w, syncJSON("old-cursor", anchorEvent, false))
	case "old-cursor":
		if recovery {
			_, _ = io.WriteString(w, syncJSON("new-cursor", latestEvent, true))
			return
		}
		<-r.Context().Done()
	default:
		<-r.Context().Done()
	}
}

func assertMatrixRecovery(t *testing.T, f *matrixRelay) {
	t.Helper()
	records, err := f.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 3 {
		t.Fatalf("replayed acceptance lost or duplicated events: %d %v", len(records), err)
	}
	byID := map[string]model.InboundSnapshot{}
	for _, record := range records {
		byID[record.Snapshot.Source.EventID] = record.Snapshot
		if record.Snapshot.Target.ThreadID != "$thread" || record.Snapshot.Endpoint.ID != "grok" {
			t.Fatalf("native thread or immutable routing lost: %+v", record.Snapshot)
		}
	}
	if byID["$anchor"].Text != "original" || byID["$middle"].Text != "backfilled" || len(byID["$latest"].Attachments) != 1 {
		t.Fatalf("backfill or media not persisted: %+v", byID)
	}
	if !byID["$anchor"].AcceptedAt.Before(byID["$middle"].AcceptedAt) || !byID["$middle"].AcceptedAt.Before(byID["$latest"].AcceptedAt) {
		t.Fatal("limited timeline was not accepted oldest first")
	}
	media, err := f.store.GetMedia(context.Background(), byID["$latest"].Channel.ID, byID["$latest"].Attachments[0].ID)
	if err != nil || media == nil || string(media.Data) != "\x01\x02\x03" {
		t.Fatalf("native attachment did not survive restart: %+v %v", media, err)
	}
}

func nativeSendPeer(t *testing.T, encrypted *atomic.Bool, sent *atomic.Int32, requests chan<- map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/account/whoami"):
			_, _ = io.WriteString(w, `{"user_id":"@bot:example.org","device_id":"DEVICE"}`)
		case strings.HasSuffix(r.URL.Path, "/sync"):
			<-r.Context().Done()
		case strings.Contains(r.URL.Path, "/state/m.room.encryption"):
			if encrypted.Load() {
				_, _ = io.WriteString(w, `{"algorithm":"m.megolm.v1.aes-sha2"}`)
				return
			}
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"errcode":"M_NOT_FOUND","error":"No state event found"}`)
		case strings.HasSuffix(r.URL.Path, "/upload"):
			data, _ := io.ReadAll(r.Body)
			if string(data) != "image" || r.Header.Get("Content-Type") != "image/png" || r.URL.Query().Get("filename") != "photo.png" {
				t.Error("native upload lost bytes or metadata")
			}
			_, _ = io.WriteString(w, `{"content_uri":"mxc://example.org/uploaded"}`)
		case strings.Contains(r.URL.Path, "/send/m.room.message/"):
			if r.Method != http.MethodPut || !strings.HasSuffix(r.URL.Path, "/transaction-1") {
				t.Error("native transaction identifier or method lost")
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			requests <- body
			sent.Add(1)
			_, _ = io.WriteString(w, `{"event_id":"$sent"}`)
		default:
			t.Errorf("unexpected native request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
}

func TestNativeSendBindsDeviceAndPreservesMediaThreadAndTransaction(t *testing.T) {
	var encrypted atomic.Bool
	var sent atomic.Int32
	requests := make(chan map[string]any, 8)
	peer := nativeSendPeer(t, &encrypted, &sent, requests)
	defer peer.Close()
	f := startMatrixRelay(t, peer, filepath.Join(t.TempDir(), "matrix.db"), false)
	defer f.close(t)
	address := model.ChannelAddress{Platform: model.Matrix, AccountID: "matrix", ChatID: "!room:example.org", ThreadID: "$thread"}
	resolved, err := f.channel.Resolve(context.Background(), address, nil)
	if err != nil || !resolved.Available || resolved.Target == nil {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	target := *resolved.Target
	target.ReplyToID = "$original"
	input := model.SendInput{Target: target, Chunk: model.DeliveryChunk{Text: "**caption**", IdempotencyKey: "transaction-1"}, Reply: &model.ReplyReference{RequestID: "request", Kind: model.Final}}
	input.Media = &model.StoredMedia{Reference: model.MediaReference{ID: "media", Kind: model.Image, MIMEType: "image/png", FileName: "photo.png", Size: 5}, Data: []byte("image")}
	input.Chunk.Media = &input.Media.Reference
	result, err := f.channel.Send(context.Background(), input)
	if err != nil || result.Status != model.Sent {
		t.Fatalf("native media send: %+v %v", result, err)
	}
	body := <-requests
	if body["msgtype"] != "m.image" || body["url"] != "mxc://example.org/uploaded" || body["body"] != "caption" || body["formatted_body"] != "<p><strong>caption</strong></p>\n" {
		t.Fatalf("native media or formatting: %+v", body)
	}
	relation, _ := body["m.relates_to"].(map[string]any)
	reply, _ := relation["m.in_reply_to"].(map[string]any)
	if relation["rel_type"] != "m.thread" || relation["event_id"] != "$thread" || reply["event_id"] != "$original" {
		t.Fatalf("thread or native quote lost: %+v", relation)
	}
	encrypted.Store(true)
	result, err = f.channel.Send(context.Background(), input)
	if err != nil || result.Status != model.Rejected || result.ErrorCode != "encrypted_unsupported" || sent.Load() != 1 {
		t.Fatalf("encrypted room was sent plaintext: %+v %v", result, err)
	}
	changed := target
	changed.Data = common.Data(targetData{Homeserver: peer.URL, UserID: "@bot:example.org", DeviceID: "REPLACED"})
	resolved, err = f.channel.Resolve(context.Background(), address, &changed)
	if err != nil || resolved.Available || resolved.Reason != "target_identity_changed" {
		t.Fatalf("replaced device reused transaction namespace: %+v %v", resolved, err)
	}
}
