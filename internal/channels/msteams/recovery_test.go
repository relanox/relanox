package msteams

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type consentHost struct {
	model.ChannelHost
	state   model.StateStore
	handler http.Handler
}

func (h *consentHost) State() model.StateStore               { return h.state }
func (h *consentHost) MaxMediaBytes() int64                  { return 20 * 1024 * 1024 }
func (h *consentHost) MountHTTP(route model.HTTPRoute) error { h.handler = route.Handler; return nil }

// Protects the native consent/upload workflow across actual SQLite reopen. A
// forgotten waiting state duplicates consent cards; a lost offset repeats accepted
// fragments. NativeClient tests cover only auth and never this durable contract.
// Only real native HTTP traffic and the production StateStore are used.
func TestFileConsentAndUploadResumeAfterReopen(t *testing.T) {
	// Envelopes: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
	// Fragments: https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
	ctx := context.Background()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var cards []string
	var ranges []string
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/.well-known/keys":
			json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "fixture", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
		case "/botframework.com/oauth2/v2.0/token":
			fmt.Fprint(w, `{"access_token":"native-token","expires_in":3600}`)
		case "/amer/v3/conversations/chat/activities":
			var body activity
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
				return
			}
			if len(body.Attachments) != 1 {
				t.Error("missing native card")
				return
			}
			cards = append(cards, body.Attachments[0].ContentType)
			fmt.Fprint(w, `{"id":"sent"}`)
		case "/upload":
			ranges = append(ranges, r.Header.Get("Content-Range"))
			io.Copy(io.Discard, r.Body)
			if len(ranges) == 2 {
				w.WriteHeader(503)
				return
			}
			if len(ranges) == 1 {
				w.WriteHeader(202)
				fmt.Fprint(w, `{"nextExpectedRanges":["10485760-"]}`)
				return
			}
			fmt.Fprint(w, `{"id":"file"}`)
		default:
			t.Errorf("unexpected native request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer peer.Close()
	base, _ := url.Parse(peer.URL)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme = base.Scheme
		copy.URL.Host = base.Host
		return http.DefaultTransport.RoundTrip(copy)
	})}
	file := filepath.Join(t.TempDir(), "state.db")
	var store *storage.Store
	var c *Channel
	var host *consentHost
	open := func() {
		store, err = storage.Open(ctx, config.Storage{Driver: "sqlite", Path: file}, nil)
		if err != nil {
			t.Fatal(err)
		}
		host = &consentHost{state: store.State(model.StateNamespace{Component: "channel", OwnerID: "account"})}
		cfg := Config{AppID: "app", BotID: "bot", TenantID: "tenant", AppSecret: model.SecretRef{Env: "SECRET"}, TrustedServiceOrigins: []string{"https://smba.trafficmanager.net"}, TrustedUploadOrigins: []string{"https://upload.example"}}
		c, err = New(host, model.AccountConfig{ID: "account", Channel: model.MSTeams, AllowedSenders: []string{"user"}, Config: common.Data(cfg)}, common.Options{HTTPClient: client, ResolveSecret: func(model.SecretRef) (string, error) { return "public-fixture", nil }})
		if err != nil {
			t.Fatal(err)
		}
	}
	close := func() {
		c.Close(ctx)
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
	}
	open()
	data := targetData{AppID: "app", TenantID: "tenant", BotID: "bot", UserID: "user", ConversationID: "chat", ServiceURL: "https://smba.trafficmanager.net/amer/", Personal: true}
	ref := model.MediaReference{ID: "media", Kind: model.File, MIMEType: "application/octet-stream", FileName: "report.bin", Size: 11 * 1024 * 1024}
	input := model.SendInput{Target: model.ReplyTarget{Channel: model.MSTeams, AccountID: "account", ChatID: "chat", Data: common.Data(data)}, Chunk: model.DeliveryChunk{IdempotencyKey: "delivery-chunk", Media: &ref}, Media: &model.StoredMedia{Reference: ref, Data: make([]byte, ref.Size)}}
	send := func(want model.Outcome) {
		t.Helper()
		result, err := c.Send(ctx, input)
		if err != nil || result.Status != want {
			t.Fatalf("send: %+v %v; want %s", result, err, want)
		}
	}
	send(model.Pending)
	close()
	open()
	send(model.Pending)
	if len(cards) != 1 {
		t.Fatal("consent card repeated after reopen")
	}
	invoke := activity{Type: "invoke", Name: "fileConsent/invoke", ChannelID: "msteams", ServiceURL: data.ServiceURL, From: identity{ID: "user"}, Recipient: identity{ID: "bot"}, Conversation: conversation{ID: "chat", TenantID: "tenant", Type: "personal"}, Value: common.Data(map[string]any{"action": "accept", "context": map[string]string{"consentId": "delivery-chunk"}, "uploadInfo": uploadInfo{UploadURL: "https://upload.example/upload", ContentURL: "https://files.example/report.bin", UniqueID: "file", FileType: "bin"}})}
	invoke.ChannelData.Tenant.ID = "tenant"
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"aud": "app", "iss": "https://api.botframework.com", "exp": time.Now().Add(time.Hour).Unix(), "serviceurl": data.ServiceURL})
	token.Header["kid"] = "fixture"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "https://relay.example/activities", bytes.NewReader(common.Data(invoke)))
	request.Header.Set("Authorization", "Bearer "+signed)
	response := httptest.NewRecorder()
	host.handler.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("consent invoke: %d", response.Code)
	}
	send(model.Retryable)
	close()
	open()
	defer close()
	send(model.Sent)
	if !reflect.DeepEqual(cards, []string{"application/vnd.microsoft.teams.card.file.consent", "application/vnd.microsoft.teams.card.file.info"}) {
		t.Fatalf("cards: %v", cards)
	}
	if !reflect.DeepEqual(ranges, []string{"bytes 0-10485759/11534336", "bytes 10485760-11534335/11534336", "bytes 10485760-11534335/11534336"}) {
		t.Fatalf("upload resumed incorrectly: %v", ranges)
	}
}
