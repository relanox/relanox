package msteams

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// The peer serves real JWKS/OAuth wire traffic; cryptographic validation is the
// production implementation. Bad audience, signature, service URL or expiration
// must reject ingress. Pairing/native HTTP tests cover none of this boundary.
// No auth bypass or test-only production API is introduced.
func TestAuthenticatedActivityAndRotatingOAuth(t *testing.T) {
	// Connector claims and JWKS are documented at:
	// https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var oauthRequests atomic.Int64
	peer := httptest.NewServer(authenticationPeer(t, key, &oauthRequests))
	defer peer.Close()
	base, _ := url.Parse(peer.URL)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme = base.Scheme
		copy.URL.Host = base.Host
		return http.DefaultTransport.RoundTrip(copy)
	})}
	secret := "first"
	native := &NativeClient{AppID: "app", TenantID: "tenant", TokenURL: "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", Secret: func() string { return secret }, HTTP: client}
	defer native.Close()
	sign := func(signing *rsa.PrivateKey, audience, service string, expires time.Time) string {
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"aud": audience, "iss": "https://api.botframework.com", "exp": expires.Unix(), "serviceurl": service})
		token.Header["kid"] = "public-fixture"
		raw, err := token.SignedString(signing)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	valid := sign(key, "app", "https://smba.trafficmanager.net/amer/", time.Now().Add(time.Hour))
	if err = native.Authenticate(context.Background(), "Bearer "+valid, "https://smba.trafficmanager.net/amer/"); err != nil {
		t.Fatal(err)
	}
	for _, input := range []struct{ token, service string }{
		{sign(key, "foreign-app", "https://smba.trafficmanager.net/amer/", time.Now().Add(time.Hour)), "https://smba.trafficmanager.net/amer/"},
		{sign(other, "app", "https://smba.trafficmanager.net/amer/", time.Now().Add(time.Hour)), "https://smba.trafficmanager.net/amer/"},
		{sign(key, "app", "https://smba.trafficmanager.net/amer/", time.Now().Add(-time.Hour)), "https://smba.trafficmanager.net/amer/"},
		{valid, "https://foreign.example/"},
	} {
		if err = native.Authenticate(context.Background(), "Bearer "+input.token, input.service); err == nil {
			t.Fatal("forged activity accepted")
		}
	}
	if err = native.Authenticate(context.Background(), valid, "https://smba.trafficmanager.net/amer/"); err == nil {
		t.Fatal("missing Bearer prefix accepted")
	}
	first, err := native.AccessToken(context.Background())
	if err != nil || first != "issued-first" {
		t.Fatalf("OAuth: %q %v", first, err)
	}
	if _, err = native.AccessToken(context.Background()); err != nil || oauthRequests.Load() != 1 {
		t.Fatal("OAuth cache unused")
	}
	secret = "rotated"
	second, err := native.AccessToken(context.Background())
	if err != nil || second != "issued-rotated" || oauthRequests.Load() != 2 {
		t.Fatal("rotated credentials not used")
	}
	native.Invalidate()
	if _, err = native.AccessToken(context.Background()); err != nil || oauthRequests.Load() != 3 {
		t.Fatal("rejected token retained")
	}
}

func authenticationPeer(t *testing.T, key *rsa.PrivateKey, oauthRequests *atomic.Int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/.well-known/keys" {
			json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "public-fixture", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
			return
		}
		if r.URL.Path == "/botframework.com/oauth2/v2.0/token" {
			oauthRequests.Add(1)
			if err := r.ParseForm(); err != nil {
				t.Error(err)
			}
			if r.Form.Get("client_id") != "app" || r.Form.Get("scope") != "https://api.botframework.com/.default" || r.Form.Get("grant_type") != "client_credentials" || r.Header.Get("Authorization") != "" {
				t.Error("incorrect OAuth identity/scope")
			}
			fmt.Fprintf(w, `{"access_token":%q,"expires_in":3600}`, "issued-"+r.Form.Get("client_secret"))
			return
		}
		t.Errorf("unexpected native path: %s", r.URL.Path)
		w.WriteHeader(404)
	})
}
