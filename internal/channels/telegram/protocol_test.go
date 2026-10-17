package telegram

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type protocolHost struct {
	model.ChannelHost
	handler  http.Handler
	received []model.IngestInput
}

func (h *protocolHost) MountHTTP(route model.HTTPRoute) error { h.handler = route.Handler; return nil }

func (h *protocolHost) MaxMediaBytes() int64 { return 1024 * 1024 }

func (h *protocolHost) Ingest(_ context.Context, input model.IngestInput) (model.IngestReceipt, error) {
	h.received = append(h.received, input)
	return model.IngestReceipt{RequestID: "accepted"}, nil
}

// Protects the native webhook identity, sender-before-download boundary and exact
// media multipart protocol. Float IDs, downloading before authorization, or using
// sendAudio for Ogg voice all fail observable external requests. Rendering tests
// cover no channel transport; no new production-only seam is introduced.
// https://core.telegram.org/bots/api#update
// https://core.telegram.org/bots/api#getfile
// https://core.telegram.org/bots/api#sendvoice
func TestWebhookAndVoiceProtocol(t *testing.T) {
	peerState := &telegramPeer{t: t}
	peer := httptest.NewTLSServer(peerState)
	defer peer.Close()
	pool := x509.NewCertPool()
	pool.AddCert(peer.Certificate())
	host := &protocolHost{}
	options := common.Options{HTTPClient: peer.Client(), TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}, ResolveSecret: func(ref model.SecretRef) (string, error) {
		if ref.Env == "WEBHOOK" {
			return "public-secret", nil
		}
		return "123:public-fixture-token", nil
	}}
	c, err := New(host, model.AccountConfig{ID: "tg", Channel: model.Telegram, AllowedSenders: []string{"9007199254740993"}, Config: common.Data(Config{BotToken: model.SecretRef{Env: "TOKEN"}, WebhookSecret: model.SecretRef{Env: "WEBHOOK"}, APIBaseURL: peer.URL})}, options)
	if err != nil {
		t.Fatal(err)
	}
	body := `{"update_id":9007199254740995,"message":{"message_id":77,"message_thread_id":4,"from":{"id":9007199254740993,"is_bot":false},"chat":{"id":-100123,"type":"supergroup"},"voice":{"file_id":"voice-id","file_size":3,"duration":1.25}}}`
	for _, secret := range []string{"incorrect", "public-secret"} {
		req := httptest.NewRequest("POST", "/webhook", strings.NewReader(body))
		req.Header.Set("X-Telegram-Bot-Api-Secret-Token", secret)
		response := httptest.NewRecorder()
		host.handler.ServeHTTP(response, req)
		want := 200
		if secret == "incorrect" {
			want = 401
		}
		if response.Code != want {
			t.Fatalf("webhook=%d want%d", response.Code, want)
		}
	}
	if peerState.downloads != 1 || len(host.received) != 1 {
		t.Fatalf("receive boundary: downloads=%d ingests=%d", peerState.downloads, len(host.received))
	}
	input := host.received[0]
	assertVoiceInput(t, input)
	address := model.ChannelAddress{Platform: model.Telegram, AccountID: "tg", ChatID: "-100123", ThreadID: "4"}
	resolved, err := c.Resolve(context.Background(), address, &input.Target)
	if err != nil || !resolved.Available {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	duration := int64(1250)
	media := model.StoredMedia{Reference: model.MediaReference{ID: "owned", Kind: model.Audio, MIMEType: "audio/ogg", FileName: "voice.oga", Size: 3, DurationMS: &duration}, Data: []byte("ogg")}
	sent, err := c.Send(context.Background(), model.SendInput{Target: *resolved.Target, Reply: &model.ReplyReference{RequestID: "req", Kind: model.Final}, Chunk: model.DeliveryChunk{Text: "**voice**", Media: &media.Reference}, Media: &media})
	if err != nil || sent.Status != model.Sent || sent.Receipt.PlatformMessageID != "1234" || !peerState.voice {
		t.Fatalf("send: %+v %v", sent, err)
	}
	mutated := *resolved.Target
	mutated.Data = common.Data(targetData{BotID: "999", APIBaseURL: peer.URL})
	resolved, err = c.Resolve(context.Background(), address, &mutated)
	if err != nil || resolved.Available {
		t.Fatal("changed bot identity accepted")
	}
	denied := strings.Replace(body, "9007199254740993", "100", 1)
	req := httptest.NewRequest("POST", "/webhook", strings.NewReader(denied))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "public-secret")
	host.handler.ServeHTTP(httptest.NewRecorder(), req)
	if peerState.downloads != 1 {
		t.Fatal("denied sender downloaded media")
	}
}

func assertVoiceInput(t *testing.T, input model.IngestInput) {
	t.Helper()
	if input.Source.EventID != "9007199254740995" || input.SenderID != "9007199254740993" || input.Target.ThreadID != "4" {
		t.Fatalf("native IDs: %+v", input)
	}
	if len(input.Attachments) != 1 || string(input.Attachments[0].Data) != "ogg" || *input.Attachments[0].DurationMS != 1250 {
		t.Fatalf("native media: %+v", input.Attachments)
	}
}

type telegramPeer struct {
	t         *testing.T
	downloads int
	voice     bool
}

func (p *telegramPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/bot123:public-fixture-token/getFile":
		var request map[string]string
		if json.NewDecoder(r.Body).Decode(&request) != nil || request["file_id"] != "voice-id" {
			p.t.Error("getFile body")
		}
		io.WriteString(w, `{"ok":true,"result":{"file_path":"voice/file.oga","file_size":3}}`)
	case "/file/bot123:public-fixture-token/voice/file.oga":
		p.downloads++
		w.Header().Set("Content-Type", "audio/ogg")
		io.WriteString(w, "ogg")
	case "/bot123:public-fixture-token/sendVoice":
		if err := r.ParseMultipartForm(1024 * 1024); err != nil {
			p.t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		if r.FormValue("chat_id") != "-100123" || r.FormValue("message_thread_id") != "4" || r.FormValue("duration") != "2" || r.FormValue("caption") != "voice" || !strings.Contains(r.FormValue("reply_parameters"), `"message_id":77`) {
			p.t.Errorf("native voice fields: %+v", r.Form)
		}
		file, header, err := r.FormFile("voice")
		if err != nil {
			p.t.Error(err)
			return
		}
		defer file.Close()
		raw, _ := io.ReadAll(file)
		if header.Filename != "voice.oga" || string(raw) != "ogg" {
			p.t.Error("voice upload")
		}
		p.voice = true
		io.WriteString(w, `{"ok":true,"result":{"message_id":1234}}`)
	default:
		p.t.Errorf("unexpected Telegram request %s", r.URL)
		w.WriteHeader(404)
	}
}

// Native retry_after is carried in the Bot API envelope even on HTTP429. A
// generic status-only mapper loses the retry deadline; existing media traffic
// checks cover only success. Unknown send outcomes must not be blindly retried.
// https://core.telegram.org/bots/api#responseparameters
func TestNativeFailureMapping(t *testing.T) {
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(429)
		io.WriteString(w, `{"ok":false,"error_code":429,"parameters":{"retry_after":17}}`)
	}))
	defer peer.Close()
	host := &protocolHost{}
	c, err := New(host, model.AccountConfig{ID: "tg", Channel: model.Telegram, Config: common.Data(Config{BotToken: model.SecretRef{Env: "TOKEN"}, WebhookSecret: model.SecretRef{Env: "WEBHOOK"}, APIBaseURL: peer.URL, AllowInsecureLoopback: true})}, common.Options{HTTPClient: peer.Client(), ResolveSecret: func(model.SecretRef) (string, error) { return "123:public", nil }})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := c.Resolve(context.Background(), model.ChannelAddress{Platform: model.Telegram, AccountID: "tg", ChatID: "4"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := c.Send(context.Background(), model.SendInput{Target: *resolved.Target, Chunk: model.DeliveryChunk{Text: "hello"}})
	if err != nil || result.Status != model.Retryable || result.RetryAfter != 17*time.Second {
		t.Fatalf("native failure: %+v %v", result, err)
	}
	if failure(&apiError{code: 408}, false).Status != model.Unknown || failure(&apiError{code: 500}, false).Status != model.Unknown {
		t.Fatal("uncertain send became retryable")
	}
}
