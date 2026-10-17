package wecom

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type passiveHost struct {
	model.ChannelHost
	state   model.StateStore
	handler http.Handler
}

func (h *passiveHost) State() model.StateStore { return h.state }
func (h *passiveHost) MountHTTP(route model.HTTPRoute) error {
	h.handler = route.Handler
	return nil
}

type passiveFixture struct {
	store  *storage.Store
	host   *passiveHost
	c      *Channel
	crypto *CallbackCrypto
	input  model.SendInput
	id     string
}

func openPassiveFixture(t *testing.T, path string) *passiveFixture {
	t.Helper()
	store, err := storage.Open(context.Background(), config.Storage{Driver: "sqlite", Path: path}, nil)
	if err != nil {
		t.Fatal(err)
	}
	f := &passiveFixture{store: store, id: streamID("bot", "event")}
	t.Cleanup(func() { f.close(t) })
	f.host = &passiveHost{state: store.State(model.StateNamespace{Component: "channel", OwnerID: "account"})}
	cfg := Config{Mode: "webhook", BotID: "bot", Token: model.SecretRef{Env: "TOKEN"}, EncodingAESKey: model.SecretRef{Env: "AES"}}
	f.c, err = New(f.host, model.AccountConfig{ID: "account", Channel: model.WeCom, AllowedSenders: []string{"user"}, Config: common.Data(cfg)}, common.Options{ResolveSecret: func(ref model.SecretRef) (string, error) {
		if ref.Env == "TOKEN" {
			return "public-fixture-token", nil
		}
		return "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY", nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	f.crypto, err = NewCallbackCrypto("public-fixture-token", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.c.startPassive(context.Background(), f.id, "event", "chat"); err != nil {
		t.Fatal(err)
	}
	target := targetData{ChatType: "group", EventID: "event"}
	target.Scope.BotID, target.Scope.Mode = "bot", "webhook"
	f.input = model.SendInput{DeliveryID: "delivery", Reply: &model.ReplyReference{RequestID: "request", Kind: model.Final}, ChunkCount: 1, Target: model.ReplyTarget{Channel: model.WeCom, AccountID: "account", ChatID: "chat", ReplyToID: "event", Data: common.Data(target)}, Chunk: model.DeliveryChunk{Text: "answer", IdempotencyKey: "chunk"}}
	assertPassiveOutcome(t, f, model.Pending)
	return f
}

func (f *passiveFixture) close(t *testing.T) {
	t.Helper()
	if f.store != nil {
		if err := f.store.Close(); err != nil {
			t.Error(err)
		}
		f.store = nil
	}
}

func assertPassiveOutcome(t *testing.T, f *passiveFixture, want model.Outcome) {
	t.Helper()
	result, err := f.c.Send(context.Background(), f.input)
	if err != nil || result.Status != want {
		t.Fatalf("final reply: %+v %v; want %s", result, err, want)
	}
}

func (f *passiveFixture) poll(t *testing.T, w http.ResponseWriter) {
	t.Helper()
	// Native stream-refresh fields, verified in the platform-maintained reference:
	// https://github.com/WecomTeam/wecom-openclaw-plugin/blob/3b1cbe3e664352821758d99ae5907f5620fce26e/src/webhook/types.ts#L189-L223
	// Only its native wire schema is used; no compatibility behavior is modeled.
	plain := `{"aibotid":"bot","msgtype":"stream","chattype":"group","chatid":"chat","from":{"userid":"user"},"stream":{"id":"` + f.id + `"}}`
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	encrypted, signature, err := f.crypto.Encrypt([]byte(plain), timestamp, "public-nonce")
	if err != nil {
		t.Fatal(err)
	}
	query := url.Values{"timestamp": {timestamp}, "nonce": {"public-nonce"}, "msg_signature": {signature}}
	r := httptest.NewRequest(http.MethodPost, "/webhook?"+query.Encode(), strings.NewReader(string(common.Data(map[string]string{"encrypt": encrypted}))))
	f.host.handler.ServeHTTP(w, r)
}

type interruptedCallback struct {
	*httptest.ResponseRecorder
	mode string
}

func (w interruptedCallback) Write(body []byte) (int, error) {
	switch w.mode {
	case "failed":
		return 0, errors.New("fixture_disconnected")
	case "partial":
		return len(body) / 2, io.ErrUnexpectedEOF
	default:
		return len(body) / 2, nil
	}
}

// A failed final callback write must remain pending across SQLite reopen. The
// native socket/crypto tests never exercise callback transmission or its durable
// delivery boundary. The only injected component is the HTTP writer, not state,
// routing, authorization or retry logic.
func TestFinalCallbackNeedsCompleteWriteAcrossReopen(t *testing.T) {
	for _, mode := range []string{"failed", "partial", "short"} {
		t.Run(mode, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.db")
			f := openPassiveFixture(t, path)
			f.poll(t, interruptedCallback{ResponseRecorder: httptest.NewRecorder(), mode: mode})
			assertPassiveOutcome(t, f, model.Pending)
			f.close(t)
			f = openPassiveFixture(t, path)
			reply := httptest.NewRecorder()
			f.poll(t, reply)
			assertPassiveBody(t, f, reply)
			assertPassiveOutcome(t, f, model.Sent)
			f.poll(t, httptest.NewRecorder())
			assertPassiveOutcome(t, f, model.Sent)
		})
	}
}

func assertPassiveBody(t *testing.T, f *passiveFixture, response *httptest.ResponseRecorder) {
	t.Helper()
	var envelope struct{ Encrypt string }
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	plain, err := f.crypto.Decrypt(envelope.Encrypt)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Type   string `json:"msgtype"`
		Stream struct {
			Content string `json:"content"`
			Finish  bool   `json:"finish"`
		} `json:"stream"`
	}
	if err = json.Unmarshal(plain, &body); err != nil {
		t.Fatal(err)
	}
	if body.Type != "stream" || !body.Stream.Finish || body.Stream.Content != "answer" {
		t.Fatalf("native final body: %s", plain)
	}
}

type replacingCallback struct {
	*httptest.ResponseRecorder
	replace func()
}

func (w replacingCallback) Write(body []byte) (int, error) {
	w.replace()
	return w.ResponseRecorder.Write(body)
}

// Confirmation belongs to the exact persisted reply that was transmitted. A
// concurrent stream replacement must not inherit the older response's success.
// This writes through real SQLite CAS rather than a StateStore mock.
func TestFinalCallbackCannotConfirmReplacementState(t *testing.T) {
	f := openPassiveFixture(t, filepath.Join(t.TempDir(), "state.db"))
	w := replacingCallback{ResponseRecorder: httptest.NewRecorder(), replace: func() {
		state, entry, err := common.ReadState[passiveState](context.Background(), f.host.State(), "stream:"+f.id)
		if err != nil || entry == nil {
			t.Fatalf("read staged reply: %+v %v", entry, err)
		}
		state.DeliveryID, state.Content, state.Served = "replacement", "new answer", false
		result, err := f.host.State().CompareAndSet(context.Background(), model.CompareAndSetStateInput{Key: entry.Key, ExpectedVersion: &entry.Version, ExpiresAt: &state.ExpiresAt, Value: common.Data(state)})
		if err != nil || result.Status != model.Updated {
			t.Fatalf("replace staged reply: %+v %v", result, err)
		}
	}}
	f.poll(t, w)
	assertPassiveBody(t, f, w.ResponseRecorder)
	f.input.DeliveryID = "replacement"
	assertPassiveOutcome(t, f, model.Pending)
}
