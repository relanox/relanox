package msteams

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
)

// The SDK accepts absent expiry and narrows JSON expires_in through int32.
// Existing rotating-token coverage uses only 3600 and cannot catch an invalid
// token entering the cache or credential echoes escaping RetrieveError. Exercise
// public AccessToken with actual HTTP and no added production seam.
// https://www.rfc-editor.org/rfc/rfc6749#section-5.1
func TestOAuthRejectsInvalidLifetimeAndSanitizesErrors(t *testing.T) {
	for _, fixture := range []struct {
		name, body string
		status     int
	}{
		{"missing-expiry", `{"access_token":"invalid"}`, 200},
		{"zero-expiry", `{"access_token":"invalid","expires_in":0}`, 200},
		{"negative-expiry", `{"access_token":"invalid","expires_in":-1}`, 200},
		{"negative-int32-wrap", `{"access_token":"invalid","expires_in":-4294963696}`, 200},
		{"credential-echo", `{"error":"invalid_client","error_description":"private-credential"}`, 401},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			var requests atomic.Int64
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.ParseForm() != nil || r.Form.Get("client_secret") != "private-credential" || r.Header.Get("Authorization") != "" {
					t.Error("OAuth credentials not in form")
				}
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "9")
				w.WriteHeader(fixture.status)
				writePeerResponse(t, w, fixture.body)
			}))
			defer peer.Close()
			native := &NativeClient{AppID: "app", TokenURL: peer.URL, Secret: func() string { return "private-credential" }, HTTP: peer.Client()}
			for range 2 {
				token, err := native.AccessToken(context.Background())
				if token != "" || err == nil || strings.Contains(err.Error(), "private-credential") {
					t.Fatalf("invalid token/error escaped: %q %v", token, err)
				}
				if fixture.status == 401 {
					var status *common.HTTPError
					if !errors.As(err, &status) || status.Status != 401 || status.Header.Get("Retry-After") != "9" {
						t.Fatalf("native status lost: %v", err)
					}
				}
			}
			if requests.Load() != 2 {
				t.Fatalf("invalid response cached or auth retried: %d", requests.Load())
			}
		})
	}
}

// JWKS cancellation coverage never requests an outbound token. Cancellation of
// token HTTP must finish the in-flight slot so the next caller can authenticate.
// The peer only delays the native OAuth response; no recovery is implemented here.
func TestOAuthCancellationReleasesInflightRequest(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	var requests atomic.Int64
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ParseForm() != nil {
			t.Error("invalid form")
		}
		if requests.Add(1) == 1 {
			close(started)
			<-r.Context().Done()
			close(stopped)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		writePeerResponse(t, w, `{"access_token":"recovered","expires_in":3600}`)
	}))
	defer peer.Close()
	native := &NativeClient{AppID: "app", TokenURL: peer.URL, Secret: func() string { return "private-credential" }, HTTP: peer.Client()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := native.AccessToken(ctx); done <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("token request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("token request ignored cancellation")
	}
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("OAuth I/O survived cancellation")
	}
	token, err := native.AccessToken(context.Background())
	if err != nil || token != "recovered" || requests.Load() != 2 {
		t.Fatalf("in-flight slot poisoned: %q %v", token, err)
	}
}
