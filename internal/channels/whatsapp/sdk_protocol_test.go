package whatsapp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/internal/channeltest"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// The SDK exposes business codes separately from HTTP status and drops native
// retry headers; success-only media/window coverage cannot detect incorrect
// retry decisions. Exercise public Send after signed acceptance in real SQLite,
// without a test-only seam. Native codes follow Meta's Cloud API error reference:
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/
func TestSDKCloudSendRetainsStatusAndRetryHeaders(t *testing.T) {
	for _, fixture := range []struct {
		name, body string
		status     int
		want       model.Outcome
		retry      time.Duration
	}{
		{"rate-limit", `{"error":{"code":130429}}`, 400, model.Retryable, 8 * time.Second},
		{"http-rate-limit", `{"error":{"code":4}}`, 429, model.Retryable, 8 * time.Second},
		{"http-timeout", `{"error":{"code":1}}`, 408, model.Unknown, 0},
		{"http-failure", `{"messaging_product":"whatsapp","messages":[{"id":"wamid.receipt"}]}`, 500, model.Unknown, 0},
		{"additional-fields", `{"messaging_product":"whatsapp","messages":[{"id":"wamid.receipt","new_receipt_field":"native"}],"new_response_field":"native"}`, 200, model.Sent, 0},
		{"null-receipt", `{"messaging_product":"whatsapp","messages":[null]}`, 200, model.Unknown, 0},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v25.0/phone/messages" || r.Header.Get("Authorization") != "Bearer public-fixture" {
					t.Error("native message scope")
				}
				w.Header().Set("Retry-After", "8")
				w.WriteHeader(fixture.status)
				channeltest.WriteResponse(t, w, fixture.body)
			}))
			defer peer.Close()
			base, _ := url.Parse(peer.URL)
			ctx := context.Background()
			store, err := storage.Open(ctx, config.Storage{Driver: "sqlite", Path: filepath.Join(t.TempDir(), "window.db")}, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = store.Close() }()
			host := &protocolHost{state: store.State(model.StateNamespace{Component: "channel", OwnerID: "wa"})}
			cfg := Config{PhoneNumberID: "phone", BusinessAccountID: "business", AppSecret: model.SecretRef{Env: "APP"}, VerifyToken: model.SecretRef{Env: "VERIFY"}, AccessToken: model.SecretRef{Env: "ACCESS"}}
			channel, err := New(host, model.AccountConfig{ID: "wa", Channel: model.WhatsApp, AllowedSenders: []string{"customer"}, Config: common.Data(cfg)}, common.Options{HTTPClient: &http.Client{Transport: rewriteTransport{base: base}}, ResolveSecret: func(model.SecretRef) (string, error) { return "public-fixture", nil }})
			if err != nil {
				t.Fatal(err)
			}
			body := cloudBody(time.Now().Unix())
			invokeWebhook(t, host.handler, body, signature(body), 200)
			if len(host.received) != 1 {
				t.Fatal("signed input not accepted")
			}
			result, err := channel.Send(ctx, model.SendInput{Target: host.received[0].Target, Chunk: model.DeliveryChunk{Text: "answer", IdempotencyKey: fmt.Sprintf("send-%s", fixture.name)}})
			if err != nil || result.Status != fixture.want || result.RetryAfter != fixture.retry {
				t.Fatalf("send: %+v %v", result, err)
			}
		})
	}
}
