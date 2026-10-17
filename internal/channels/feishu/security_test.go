package feishu

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	larkevent "github.com/larksuite/oapi-sdk-go/v3/event"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type webhookHost struct {
	outboundHost
	handler http.Handler
}

func (h *webhookHost) MountHTTP(route model.HTTPRoute) error { h.handler = route.Handler; return nil }

// A forged or stale callback must not enter processing, while platform URL
// verification remains available. Outbound wire tests never exercise this
// authentication boundary. No auth bypass or production-only seam is added.
func TestSignedWebhookIdentityAndVerification(t *testing.T) {
	// Signature/challenge contract:
	// https://open.feishu.cn/document/server-docs/event-subscription-guide/overview
	// Verified implementation: oapi-sdk-go v3.12.2 event/event.go Signature.
	host := &webhookHost{}
	cfg := Config{AppID: "app", TenantKey: "tenant", AppSecret: model.SecretRef{Env: "APP"}, VerificationToken: model.SecretRef{Env: "VERIFY"}, EncryptKey: model.SecretRef{Env: "ENCRYPT"}}
	_, err := New(host, model.AccountConfig{ID: "account", Channel: model.Feishu, Config: common.Data(cfg)}, common.Options{ResolveSecret: func(ref model.SecretRef) (string, error) {
		return map[string]string{"APP": "app-secret", "VERIFY": "verification-token", "ENCRYPT": "encrypt-key"}[ref.Env], nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	valid := `{"schema":"2.0","header":{"event_id":"event","event_type":"other.event","app_id":"app","tenant_key":"tenant","token":"verification-token"}}`
	foreign := `{"schema":"2.0","header":{"event_id":"event","event_type":"other.event","app_id":"app","tenant_key":"foreign","token":"verification-token"}}`
	for _, fixture := range []struct {
		body   string
		signed bool
		age    time.Duration
		status int
	}{
		{`{"type":"url_verification","token":"verification-token","challenge":"public-challenge"}`, false, 0, 200},
		{`{"type":"url_verification","token":"foreign","challenge":"public-challenge"}`, false, 0, 401},
		{valid, false, 0, 401},
		{valid, true, 0, 200},
		{foreign, true, 0, 401},
		{valid, true, time.Hour, 401},
	} {
		request := httptest.NewRequest(http.MethodPost, "https://relay.example/webhook", bytes.NewBufferString(fixture.body))
		if fixture.signed {
			timestamp := strconv.FormatInt(time.Now().Add(-fixture.age).Unix(), 10)
			request.Header.Set("x-lark-request-timestamp", timestamp)
			request.Header.Set("x-lark-request-nonce", "nonce")
			request.Header.Set("x-lark-signature", larkevent.Signature(timestamp, "nonce", "encrypt-key", fixture.body))
		}
		response := httptest.NewRecorder()
		host.handler.ServeHTTP(response, request)
		if response.Code != fixture.status {
			t.Fatalf("callback status: %d; want %d", response.Code, fixture.status)
		}
		if fixture.status == 200 && !fixture.signed {
			var body map[string]string
			if json.Unmarshal(response.Body.Bytes(), &body) != nil || body["challenge"] != "public-challenge" {
				t.Fatal("challenge response lost")
			}
		}
	}
}
