package core_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/wecom"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type wecomRelay struct {
	*relayFixture
	channel *wecom.Channel
	crypto  *wecom.CallbackCrypto
}

func newWeComRelay(t *testing.T, path string, start bool) *wecomRelay {
	t.Helper()
	f := &wecomRelay{relayFixture: &relayFixture{}}
	f.ctx, f.cancel = context.WithCancel(context.Background())
	f.routine = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		// Routine success receipt: https://cursor.com/help/grok-bot/routines#where-do-the-webhook-url-and-key-live-and-what-does-a-200-mean
		w.WriteHeader(http.StatusOK)
	}))
	f.relay = httptest.NewUnstartedServer(nil)
	key := base64.RawStdEncoding.EncodeToString([]byte("01234567890123456789012345678901"))
	account := model.AccountConfig{ID: "wecom", Channel: model.WeCom, AllowedSenders: []string{"alice"}, Config: common.Data(wecom.Config{Mode: "webhook", BotID: "bot", Token: model.SecretRef{Env: "CALLBACK_TOKEN"}, EncodingAESKey: model.SecretRef{Env: "CALLBACK_AES"}})}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Token: model.SecretRef{Env: "MCP"}}, RoutineURL: model.SecretRef{Env: "ROUTINE"}, RoutineAuthorization: model.SecretRef{Env: "ROUTINE_AUTH"}})}
	cfg := relayConfig(t, "http://"+f.relay.Listener.Addr().String(), account, endpoint, path)
	resolve := func(ref model.SecretRef) (string, error) {
		return map[string]string{"CALLBACK_TOKEN": "callback-token", "CALLBACK_AES": key, "MCP": "mcp-token", "ROUTINE": f.routine.URL, "ROUTINE_AUTH": "Bearer routine"}[ref.Env], nil
	}
	var err error
	f.store, err = storage.Open(f.ctx, cfg.Storage, nil)
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
	f.channel, err = wecom.New(f.host, account, common.Options{ResolveSecret: resolve})
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
	agent, err := grok.New(endpoint, agentmcp.Dependencies{Host: host, ResolveSecret: resolve, HTTPClient: f.routine.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runtime.AttachAgent(endpoint.ID, agent); err != nil {
		t.Fatal(err)
	}
	f.crypto, err = wecom.NewCallbackCrypto("callback-token", key, "")
	if err != nil {
		t.Fatal(err)
	}
	f.relay.Config.Handler = f.runtime.Handler()
	f.relay.Start()
	if start {
		if err = f.runtime.Start(f.ctx); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { closeWeComRelay(t, f) })
	return f
}

func closeWeComRelay(t *testing.T, f *wecomRelay) {
	t.Helper()
	f.cancel()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.runtime.Close(ctx); err != nil {
		t.Error(err)
	}
	f.relay.Close()
	f.routine.Close()
	_ = f.store.Close()
}

type wecomStream struct {
	ID      string `json:"id"`
	Finish  bool   `json:"finish"`
	Content string `json:"content"`
}

// Native callback envelope and stream poll fields verified against the SDK:
// https://github.com/WecomTeam/aibot-node-sdk (wecom-crypto and WSClient).
func callbackWeCom(t *testing.T, f *wecomRelay, message string) wecomStream {
	t.Helper()
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	encrypted, signature, err := f.crypto.Encrypt([]byte(message), timestamp, "native-nonce")
	if err != nil {
		t.Fatal(err)
	}
	query := url.Values{"timestamp": {timestamp}, "nonce": {"native-nonce"}, "msg_signature": {signature}}
	request, err := http.NewRequestWithContext(f.ctx, "POST", f.relay.URL+"/channels/wecom/wecom/webhook?"+query.Encode(), strings.NewReader(string(common.Data(map[string]string{"encrypt": encrypted}))))
	if err != nil {
		t.Fatal(err)
	}
	response, err := f.relay.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("native callback=%d", response.StatusCode)
	}
	var envelope struct {
		Encrypt string `json:"encrypt"`
	}
	if err = json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	plain, err := f.crypto.Decrypt(envelope.Encrypt)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Stream wecomStream `json:"stream"`
	}
	if err = json.Unmarshal(plain, &result); err != nil {
		t.Fatal(err)
	}
	return result.Stream
}

func waitWeComPending(t *testing.T, store *storage.Store, id string, minimumVersion int64) *model.OutboundRecord {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		record, err := store.GetOutbound(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if record != nil {
			if record.Status != model.DeliveryPending {
				t.Fatalf("passive delivery lost pending state: %#v", record)
			}
			if record.Lease == nil && record.Version >= minimumVersion {
				return record
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("passive delivery did not settle as pending")
	return nil
}

// A native passive reply is already reserved and accumulated by delivery/chunk
// in real state. If its lease is interrupted, the real core must replay that
// operation and wait for the platform poll. Channel-only tests cannot catch a
// missing IdempotentSend declaration making storage label it unknown. No peer
// implements routing/retry/persistence; the crash fixture uses real lease APIs.
func TestWeComPassiveDeliveryRecoversInterruptedLeaseWithoutDuplicateText(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.db")
	first := newWeComRelay(t, path, true)
	websocketAccount := model.AccountConfig{ID: "wecom", Channel: model.WeCom, Config: common.Data(wecom.Config{BotID: "bot", Secret: model.SecretRef{Env: "SOCKET_SECRET"}})}
	socket, err := wecom.New(first.host, websocketAccount, common.Options{})
	if err != nil || socket.Capabilities().IdempotentSend {
		t.Fatalf("socket sends declared durable replayable: %v", err)
	}
	stream := callbackWeCom(t, first, `{"msgid":"native-event","aibotid":"bot","chattype":"single","from":{"userid":"alice"},"msgtype":"text","text":{"content":"question"}}`)
	if stream.ID == "" || stream.Finish {
		t.Fatal("initial callback did not open native stream")
	}
	record := awaitInbound(t, first.store, model.AttemptAccepted)
	session := connectMCP(t, first.relayFixture)
	receipt := callTool[model.MessageReceipt](t, first.relayFixture, session, "relanox_send_message", map[string]any{"channel": record.Snapshot.Channel.ID, "text": "durable native answer", "idempotencyKey": "passive-final", "reply": map[string]any{"requestId": record.Snapshot.RequestID, "kind": "final"}})
	_ = session.Close()
	waitWeComPending(t, first.store, receipt.DeliveryID, 3)
	closeWeComRelay(t, first)
	// Claim the already staged operation, then lose the process before settling
	// the lease. A future claim time makes the pending retry eligible immediately.
	store, err := storage.OpenExisting(context.Background(), config.Storage{Driver: "sqlite", Path: path}, nil)
	if err != nil {
		t.Fatal(err)
	}
	work, err := store.TakeDue(context.Background(), model.TakeDueInput{Now: time.Now().Add(2 * time.Second), LeaseDuration: time.Minute, SendLeaseDuration: time.Nanosecond, LeaseOwner: "interrupted-process", Limit: 1, PreferredKind: model.SendWork})
	if err != nil || len(work) != 1 || work[0].Kind != model.SendWork {
		t.Fatalf("interrupted lease=%#v %v", work, err)
	}
	_ = store.Close()
	resumed := newWeComRelay(t, path, false)
	outbound := work[0].Outbound
	staged, err := resumed.channel.Send(resumed.ctx, model.SendInput{Reply: outbound.Reply, DeliveryID: outbound.DeliveryID, ChannelID: outbound.ChannelID, Target: outbound.Target, Chunk: outbound.Chunks[outbound.CurrentChunk], ChunkIndex: outbound.CurrentChunk, ChunkCount: len(outbound.Chunks)})
	if err != nil || staged.Status != model.Pending {
		t.Fatalf("durable native replay=%#v %v", staged, err)
	}
	if err = resumed.runtime.Start(resumed.ctx); err != nil {
		t.Fatal(err)
	}
	ready := waitWeComPending(t, resumed.store, receipt.DeliveryID, outbound.Version+2)
	if ready.Attempts != 0 {
		t.Fatalf("native pending consumed attempts: %d", ready.Attempts)
	}
	polled := callbackWeCom(t, resumed, `{"aibotid":"bot","chattype":"single","from":{"userid":"alice"},"msgtype":"stream","stream":{"id":"`+stream.ID+`"}}`)
	if !polled.Finish || polled.Content != "durable native answer" {
		t.Fatalf("recovered native reply duplicated or lost: %#v", polled)
	}
	awaitDelivery(t, resumed.store, receipt.DeliveryID, model.DeliverySent)
}
