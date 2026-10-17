package whatsapp

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
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
	handler  http.Handler
	received []model.IngestInput
}

func (h *protocolHost) State() model.StateStore { return h.state }

func (h *protocolHost) MountHTTP(route model.HTTPRoute) error { h.handler = route.Handler; return nil }

func (h *protocolHost) MaxMediaBytes() int64 { return 1024 * 1024 }

func (h *protocolHost) Ingest(_ context.Context, input model.IngestInput) (model.IngestReceipt, error) {
	h.received = append(h.received, input)
	return model.IngestReceipt{RequestID: "req"}, nil
}

type rewriteTransport struct{ base *url.URL }

func (t rewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	copy.URL.Scheme = t.base.Scheme
	copy.URL.Host = t.base.Host
	return http.DefaultTransport.RoundTrip(copy)
}

// Protects Meta's signed webhook, durable 24-hour customer window and native
// reply/media envelope. Reopening SQLite catches an in-memory-only window; a
// reordered webhook must not shorten it. Telegram tests have no window policy.
// Only external HTTP and production StateStore are used, with no extra seam.
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components/
// https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api
func TestWindowRecoveryAndCloudProtocol(t *testing.T) {
	ctx := context.Background()
	peerState := &cloudPeer{t: t}
	peer := httptest.NewServer(peerState)
	defer peer.Close()
	base, _ := url.Parse(peer.URL)
	client := &http.Client{Transport: rewriteTransport{base: base}}
	filename := filepath.Join(t.TempDir(), "window.db")
	open := func() (*storage.Store, *protocolHost, *Channel) {
		t.Helper()
		store, err := storage.Open(ctx, config.Storage{Driver: "sqlite", Path: filename}, nil)
		if err != nil {
			t.Fatal(err)
		}
		host := &protocolHost{state: store.State(model.StateNamespace{Component: "channel", OwnerID: "wa"})}
		cfg := Config{PhoneNumberID: "phone", BusinessAccountID: "business", AppSecret: model.SecretRef{Env: "APP"}, VerifyToken: model.SecretRef{Env: "VERIFY"}, AccessToken: model.SecretRef{Env: "ACCESS"}}
		channel, err := New(host, model.AccountConfig{ID: "wa", Channel: model.WhatsApp, AllowedSenders: []string{"customer"}, Config: common.Data(cfg)}, common.Options{HTTPClient: client, ResolveSecret: func(model.SecretRef) (string, error) { return "public-fixture", nil }})
		if err != nil {
			t.Fatal(err)
		}
		return store, host, channel
	}
	store, host, channel := open()
	address := model.ChannelAddress{Platform: model.WhatsApp, AccountID: "wa", ChatID: "customer"}
	resolved, err := channel.Resolve(ctx, address, nil)
	if err != nil || resolved.Available {
		t.Fatal("unsolicited freeform send available")
	}
	now := time.Now().Unix()
	body := cloudBody(now)
	invokeWebhook(t, host.handler, body, "invalid", 401)
	invokeWebhook(t, host.handler, body, signature(body), 200)
	if len(host.received) != 1 || host.received[0].Target.ChatID != "customer" || host.received[0].Text != "hello" {
		t.Fatalf("native receive: %+v", host.received)
	}
	target := host.received[0].Target
	first, err := channel.window(ctx, "customer")
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, host, channel = open()
	defer store.Close()
	older := cloudBody(now - 3600)
	invokeWebhook(t, host.handler, older, signature(older), 200)
	second, err := channel.window(ctx, "customer")
	if err != nil || second != first {
		t.Fatalf("window regressed %d %d %v", first, second, err)
	}
	resolved, err = channel.Resolve(ctx, address, &target)
	if err != nil || !resolved.Available || resolved.Target.ReplyToID != "wamid.inbound" {
		t.Fatalf("recover target: %+v %v", resolved, err)
	}
	assertCloudSends(t, channel, *resolved.Target, peerState)
	assertLearnedIdentity(t, channel, address, target)
	if err = common.SaveState(ctx, host.State(), channel.windowKey("customer"), time.Now().Add(-time.Minute).UnixMilli(), nil); err != nil {
		t.Fatal(err)
	}
	sent, err := channel.Send(ctx, model.SendInput{Target: target, Chunk: model.DeliveryChunk{Text: "late"}})
	if err != nil || sent.ErrorCode != "customer_window_expired" || peerState.messages != 2 {
		t.Fatalf("expired target: %+v %v", sent, err)
	}
}

func assertLearnedIdentity(t *testing.T, channel *Channel, address model.ChannelAddress, original model.ReplyTarget) {
	t.Helper()
	for _, change := range []string{"phone", "business", "customer"} {
		target := original
		data := channel.target(original.ChatID)
		switch change {
		case "phone":
			data.PhoneNumberID = "replacement"
		case "business":
			data.BusinessAccountID = "replacement"
		case "customer":
			data.Customer = "another-customer"
			target.ChatID = data.Customer
		}
		target.Data = common.Data(data)
		resolved, err := channel.Resolve(context.Background(), address, &target)
		if err != nil || resolved.Available || resolved.Reason != "target_identity_changed" {
			t.Fatalf("changed %s accepted: %+v %v", change, resolved, err)
		}
	}
}

func assertCloudSends(t *testing.T, channel *Channel, target model.ReplyTarget, peerState *cloudPeer) {
	t.Helper()
	ctx := context.Background()
	sent, err := channel.Send(ctx, model.SendInput{Target: target, Reply: &model.ReplyReference{RequestID: "req", Kind: model.Final}, Chunk: model.DeliveryChunk{Text: "**answer**"}})
	if err != nil || sent.Status != model.Sent || sent.Receipt.PlatformMessageID != "wamid.outbound" {
		t.Fatalf("text: %+v %v", sent, err)
	}
	media := model.StoredMedia{Reference: model.MediaReference{ID: "owned", Kind: model.Image, MIMEType: "image/png", FileName: "photo.png", Size: 3}, Data: []byte("png")}
	sent, err = channel.Send(ctx, model.SendInput{Target: target, Chunk: model.DeliveryChunk{Text: "image", Media: &media.Reference}, Media: &media})
	if err != nil || sent.Status != model.Sent || !peerState.uploaded || !peerState.image {
		t.Fatalf("image: %+v %v", sent, err)
	}
}

func cloudBody(timestamp int64) string {
	return fmt.Sprintf(`{"object":"whatsapp_business_account","entry":[{"id":"business","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"phone"},"messages":[{"id":"wamid.inbound","from":"customer","timestamp":"%d","type":"text","text":{"body":"hello"}}]}}]}]}`, timestamp)
}

func signature(body string) string {
	mac := hmac.New(sha256.New, []byte("public-fixture"))
	mac.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func invokeWebhook(t *testing.T, handler http.Handler, body, signature string, want int) {
	t.Helper()
	request := httptest.NewRequest("POST", "/webhook", strings.NewReader(body))
	request.Header.Set("X-Hub-Signature-256", signature)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != want {
		t.Fatalf("webhook %d want%d", response.Code, want)
	}
}

type cloudPeer struct {
	t               *testing.T
	uploaded, image bool
	messages        int
}

func (p *cloudPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Header.Get("Authorization") != "Bearer public-fixture" {
		p.t.Error("Cloud auth")
	}
	switch r.URL.Path {
	case "/v25.0/phone/media":
		if err := r.ParseMultipartForm(1024 * 1024); err != nil {
			p.t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		if r.FormValue("messaging_product") != "whatsapp" || r.FormValue("type") != "image/png" {
			p.t.Error("upload metadata")
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			p.t.Error(err)
			return
		}
		defer file.Close()
		raw, _ := io.ReadAll(file)
		if string(raw) != "png" {
			p.t.Error("upload bytes")
		}
		p.uploaded = true
		io.WriteString(w, `{"id":"native-media"}`)
	case "/v25.0/phone/messages":
		p.messages++
		var body struct {
			Product string `json:"messaging_product"`
			To      string `json:"to"`
			Type    string `json:"type"`
			Text    struct {
				Body string `json:"body"`
			} `json:"text"`
			Context struct {
				ID string `json:"message_id"`
			} `json:"context"`
			Image struct {
				ID      string `json:"id"`
				Caption string `json:"caption"`
			} `json:"image"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			p.t.Error(err)
		}
		if body.Product != "whatsapp" || body.To != "customer" {
			p.t.Error("message destination")
		}
		if body.Type == "text" && (body.Text.Body != "*answer*" || body.Context.ID != "wamid.inbound") {
			p.t.Errorf("native text %+v", body)
		}
		if body.Type == "image" {
			if body.Image.ID != "native-media" || body.Image.Caption != "image" {
				p.t.Error("native image")
			}
			p.image = true
		}
		io.WriteString(w, `{"messaging_product":"whatsapp","messages":[{"id":"wamid.outbound"}]}`)
	default:
		p.t.Errorf("unexpected Cloud request %s", r.URL)
		w.WriteHeader(404)
	}
}
