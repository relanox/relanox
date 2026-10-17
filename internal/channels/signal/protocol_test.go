package signal

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type protocolHost struct {
	model.ChannelHost
	state    model.StateStore
	fail     atomic.Bool
	received chan model.IngestInput
	status   chan model.ConnectionStatus
}

func (h *protocolHost) State() model.StateStore { return h.state }

func (h *protocolHost) MaxMediaBytes() int64 { return 1024 * 1024 }

func (h *protocolHost) Connection(status model.ConnectionStatus, _ string) {
	select {
	case h.status <- status:
	default:
	}
}

func (h *protocolHost) Ingest(_ context.Context, input model.IngestInput) (model.IngestReceipt, error) {
	if h.fail.Load() {
		return model.IngestReceipt{}, errors.New("storage_unavailable")
	}
	h.received <- input
	return model.IngestReceipt{RequestID: "accepted"}, nil
}

type fixture struct {
	store   *storage.Store
	host    *protocolHost
	channel *Channel
}

func openFixture(t *testing.T, filename, base string, roots *x509.CertPool) fixture {
	t.Helper()
	store, err := storage.Open(context.Background(), config.Storage{Driver: "sqlite", Path: filename}, nil)
	if err != nil {
		t.Fatal(err)
	}
	host := &protocolHost{state: store.State(model.StateNamespace{Component: "channel", OwnerID: "signal"}), received: make(chan model.IngestInput, 10), status: make(chan model.ConnectionStatus, 10)}
	ref := model.SecretRef{Env: "AUTH"}
	cfg := Config{ServiceURL: base, Account: "+12025550100", Authorization: &ref}
	channel, err := New(host, model.AccountConfig{ID: "signal", Channel: model.Signal, AllowedSenders: []string{"sender-uuid"}, Config: common.Data(cfg)}, common.Options{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, ResolveSecret: func(model.SecretRef) (string, error) { return "Bearer public-fixture", nil }})
	if err != nil {
		t.Fatal(err)
	}
	return fixture{store: store, host: host, channel: channel}
}

// Protects native SSE replay after failed acceptance and SQLite reopen, plus
// configured private TLS bridge transport and native attachment/quote envelopes.
// Advancing the cursor early loses the failed event; generic HTTP tests cannot
// exercise SSE acknowledgement. The host only injects failure/records input,
// and recovery uses the production StateStore; no artificial seam is added.
// https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc
// https://github.com/AsamK/signal-cli/blob/master/src/main/java/org/asamk/signal/http/SseEventBuffer.java
// https://github.com/AsamK/signal-cli/blob/master/src/main/java/org/asamk/signal/commands/GetAttachmentCommand.java
func TestSSEAcceptanceCheckpointAndReopen(t *testing.T) {
	ctx := context.Background()
	peerState := &signalPeer{t: t, cursors: make(chan string, 10)}
	peer := httptest.NewTLSServer(peerState)
	defer peer.Close()
	roots := x509.NewCertPool()
	roots.AddCert(peer.Certificate())
	filename := filepath.Join(t.TempDir(), "signal.db")
	fixture := openFixture(t, filename, peer.URL, roots)
	if err := common.SaveState(ctx, fixture.host.State(), fixture.channel.cursorKey(), "daemon-1", nil); err != nil {
		t.Fatal(err)
	}
	fixture.host.fail.Store(true)
	if err := fixture.channel.Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, fixture.host.status, model.Degraded)
	stop(t, fixture.channel)
	cursor, _, err := common.ReadState[string](ctx, fixture.host.State(), fixture.channel.cursorKey())
	if err != nil || cursor != "daemon-1" {
		t.Fatalf("cursor advanced on failed acceptance: %q %v", cursor, err)
	}
	if err = fixture.store.Close(); err != nil {
		t.Fatal(err)
	}
	fixture = openFixture(t, filename, peer.URL, roots)
	defer fixture.store.Close()
	if err = fixture.channel.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer stop(t, fixture.channel)
	var input model.IngestInput
	select {
	case input = <-fixture.host.received:
	case <-time.After(3 * time.Second):
		t.Fatal("event was not replayed")
	}
	waitCursor(t, fixture.host.State(), fixture.channel.cursorKey(), "daemon-2")
	for i := 0; i < 2; i++ {
		select {
		case value := <-peerState.cursors:
			if value != "daemon-1" {
				t.Fatalf("replay cursor %q", value)
			}
		case <-time.After(time.Second):
			t.Fatal("missing SSE connection")
		}
	}
	if input.Source.EventID != "sender-uuid:1700000000000:group:native-group==" || input.Target.ChatID != "group:native-group==" || input.Text != "original" || len(input.Attachments) != 1 || string(input.Attachments[0].Data) != "png" {
		t.Fatalf("native event: %+v", input)
	}
	assertNativeSend(t, fixture.channel, input.Target, peerState)
}

func stop(t *testing.T, channel *Channel) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := channel.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func waitStatus(t *testing.T, status <-chan model.ConnectionStatus, want model.ConnectionStatus) {
	t.Helper()
	timeout := time.NewTimer(3 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case value := <-status:
			if value == want {
				return
			}
		case <-timeout.C:
			t.Fatalf("did not reach %s", want)
		}
	}
}

func waitCursor(t *testing.T, state model.StateStore, key, want string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		value, _, err := common.ReadState[string](context.Background(), state, key)
		if err != nil {
			t.Fatal(err)
		}
		if value == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("accepted event did not checkpoint")
}

func assertNativeSend(t *testing.T, channel *Channel, target model.ReplyTarget, peer *signalPeer) {
	t.Helper()
	ctx := context.Background()
	media := model.StoredMedia{Reference: model.MediaReference{ID: "owned", Kind: model.Image, MIMEType: "image/png", FileName: "my photo.png", Size: 3}, Data: []byte("png")}
	input := model.SendInput{Target: target, Reply: &model.ReplyReference{RequestID: "req", Kind: model.Final}, Chunk: model.DeliveryChunk{IdempotencyKey: "send", Text: "😀 **bold**", Media: &media.Reference}, Media: &media}
	result, err := channel.Send(ctx, input)
	if err != nil || result.Status != model.Sent || result.Receipt.PlatformMessageID != "1700000001000" {
		t.Fatalf("send: %+v %v", result, err)
	}
	peer.partial.Store(true)
	input.Chunk.IdempotencyKey = "partial"
	result, err = channel.Send(ctx, input)
	if err != nil || result.Status != model.Unknown || result.ErrorCode != "rpc_recipient_failure" {
		t.Fatalf("partial group retried: %+v %v", result, err)
	}
	var data targetData
	if json.Unmarshal(target.Data, &data) != nil {
		t.Fatal("target data")
	}
	data.Account = "replacement"
	target.Data = common.Data(data)
	resolved, err := channel.Resolve(ctx, model.ChannelAddress{Platform: model.Signal, AccountID: "signal", ChatID: target.ChatID}, &target)
	if err != nil || resolved.Available {
		t.Fatal("replacement account rebound old target")
	}
}

type signalPeer struct {
	t       *testing.T
	cursors chan string
	partial atomic.Bool
}

func (p *signalPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer public-fixture" {
		p.t.Error("Signal bridge authorization")
	}
	switch r.URL.Path {
	case "/api/v1/events":
		if r.URL.Query().Get("account") != "+12025550100" || r.Header.Get("Accept") != "text/event-stream" {
			p.t.Error("SSE scope")
		}
		p.cursors <- r.Header.Get("Last-Event-ID")
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "id: daemon-2\nevent: receive\ndata: "+nativeEvent+"\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	case "/api/v1/rpc":
		p.rpc(w, r)
	default:
		p.t.Errorf("unexpected Signal request %s", r.URL)
		w.WriteHeader(404)
	}
}

const nativeEvent = `{"account":"+12025550100","envelope":{"source":"+12025550101","sourceNumber":"+12025550101","sourceUuid":"sender-uuid","timestamp":1700000000000,"dataMessage":{"timestamp":1700000000000,"message":"original","viewOnce":false,"groupInfo":{"groupId":"native-group=="},"attachments":[{"id":"native-attachment","contentType":"image/png","filename":"image.png","size":3}]}}}`

func (p *signalPeer) rpc(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var request struct {
		Version string                     `json:"jsonrpc"`
		ID      string                     `json:"id"`
		Method  string                     `json:"method"`
		Params  map[string]json.RawMessage `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		p.t.Error(err)
		return
	}
	if request.Version != "2.0" || string(request.Params["account"]) != `"+12025550100"` {
		p.t.Error("RPC scope")
	}
	switch request.Method {
	case "getAttachment":
		if string(request.Params["id"]) != `"native-attachment"` || string(request.Params["groupId"]) != `"native-group=="` {
			p.t.Error("attachment parameters")
		}
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%q,"result":{"data":"cG5n"}}`, request.ID)
	case "send":
		assertSendParams(p.t, request.Params)
		kind := "SUCCESS"
		if p.partial.Load() {
			kind = "NETWORK_FAILURE"
		}
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%q,"result":{"timestamp":1700000001000,"results":[{"type":"SUCCESS"},{"type":%q}]}}`, request.ID, kind)
	default:
		p.t.Errorf("unexpected RPC method %s", request.Method)
		io.WriteString(w, `{"error":{"code":-32601}}`)
	}
}

func assertSendParams(t *testing.T, params map[string]json.RawMessage) {
	t.Helper()
	if string(params["groupId"]) != `"native-group=="` || string(params["message"]) != `"😀 bold"` || string(params["textStyle"]) != `["3:4:BOLD"]` {
		t.Errorf("native message/style: %+v", params)
	}
	if string(params["quoteTimestamp"]) != "1700000000000" || string(params["quoteAuthor"]) != `"sender-uuid"` || string(params["quoteMessage"]) != `"original"` {
		t.Error("native quote")
	}
	if !strings.Contains(string(params["attachments"]), "data:image/png;filename=my%20photo.png;base64,cG5n") {
		t.Error("native attachment data URI")
	}
}
