package dot

import (
	"encoding/json"
	"strings"
	"testing"
)

// Independent signing vector from the official Standard Webhooks Go test:
// https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/go/webhook_test.go
// Protects the externally verified HMAC, raw-body and header serialization
// contract. Existing native Muse/Grok tests do not exercise webhook signing.
func TestStandardWebhooksGoldenSignature(t *testing.T) {
	got, err := webhookSignature("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", "1614265330", []byte(`{"test": 2432232314}`))
	if err != nil || got != "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" {
		t.Fatal(got, err)
	}
	for _, secret := range []string{"whsec_", "whsec_YQ==", "whsec_" + strings.Repeat("A", 128), "secret", "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw\n"} {
		if _, err = webhookSignature(secret, "id", "0", nil); err == nil {
			t.Fatal("accepted invalid signing key")
		}
	}
}

func TestCallbackURLAcceptsOnlyNativeOpenAIOrigin(t *testing.T) {
	for _, value := range []string{"http://connectors.api.openai.com/callback", "https://connectors.api.openai.com.evil.example/callback", "https://connectors.api.openai.com:8443/callback", "https://user@connectors.api.openai.com/callback", "https://connectors.api.openai.com/callback#fragment", "https://127.0.0.1/callback"} {
		if _, err := callbackURL(value); err == nil {
			t.Fatal("accepted nonnative callback")
		}
	}
	value, err := callbackURL("https://connectors.api.openai.com:443/callback?token=opaque")
	if err != nil || value != "https://connectors.api.openai.com/callback?token=opaque" {
		t.Fatal(value, err)
	}
}

func TestEventsRejectCallerScopeAndForeignDeliveryContract(t *testing.T) {
	for _, raw := range []string{`{"name":"relanox.message_available","arguments":{"endpointId":"foreign"},"delivery":{"mode":"webhook","url":"https://connectors.api.openai.com/callback","secret":"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"}}`, `{"name":"relanox.message_available","arguments":{},"endpointId":"foreign","delivery":{"mode":"webhook","url":"https://connectors.api.openai.com/callback","secret":"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"}}`} {
		var params subscribeParams
		if json.Unmarshal([]byte(raw), &params) == nil {
			t.Fatal("accepted caller-controlled scope")
		}
	}
	for _, raw := range []string{`{"name":"relanox.message_available","arguments":{},"delivery":{"mode":"sse","url":"https://connectors.api.openai.com/callback","secret":"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"}}`, `{"name":"other","arguments":{},"delivery":{"mode":"webhook","url":"https://connectors.api.openai.com/callback","secret":"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"}}`, `{"name":"relanox.message_available","arguments":{},"ttlMs":1,"delivery":{"mode":"webhook","url":"https://connectors.api.openai.com/callback","secret":"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"}}`} {
		var params subscribeParams
		if json.Unmarshal([]byte(raw), &params) != nil || params.validate() == nil {
			t.Fatal("invalid event parameters accepted")
		}
	}
}
