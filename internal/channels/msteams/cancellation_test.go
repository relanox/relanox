package msteams

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Authenticate cancellation must reach the initial JWKS HTTP request and leave
// later requests able to load keys. Binding initialization only to the channel
// lifetime stalls disconnected callers and retains failed refresh loops. Happy
// path auth tests have no blocked I/O; no production-only seam is introduced.
func TestAuthenticateCancelsInitialJWKSDownloadWithoutPoisoningCache(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	started, cancelled := make(chan struct{}), make(chan struct{})
	var requests atomic.Int64
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			close(started)
			<-r.Context().Done()
			close(cancelled)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		writePeerJSON(t, w, map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "fixture", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
	}))
	defer peer.Close()
	base, _ := url.Parse(peer.URL)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme = base.Scheme
		copy.URL.Host = base.Host
		return http.DefaultTransport.RoundTrip(copy)
	})}
	native := &NativeClient{AppID: "app", TenantID: "tenant", HTTP: client}
	defer native.Close()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": "https://api.botframework.com", "aud": "app", "exp": time.Now().Add(time.Hour).Unix(), "serviceurl": "https://service.example/"})
	token.Header["kid"] = "fixture"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- native.Authenticate(ctx, "Bearer "+signed, "https://service.example/") }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("initial JWKS download did not start")
	}
	cancel()
	select {
	case err = <-finished:
		if err == nil {
			t.Fatal("cancelled activity authenticated")
		}
	case <-time.After(time.Second):
		t.Fatal("Authenticate ignored request cancellation")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("JWKS network request survived cancellation")
	}
	if err = native.Authenticate(context.Background(), "Bearer "+signed, "https://service.example/"); err != nil {
		t.Fatalf("cancelled initialization poisoned later auth: %v", err)
	}
}
