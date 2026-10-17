package transport_test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/transport"
)

// Custom enterprise CAs must work without disabling verification. Ignoring the
// TLS option fails the trusted request; default plaintext tests cannot catch it.
// This uses real TLS and the production trust configuration, without a bypass.
func TestClientAcceptsExplicitCertificateAuthority(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.WriteString(w, `{"ok":true}`); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client := transport.NewClient(transport.Options{AllowPrivateHosts: []string{"127.0.0.1"}, TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}})
	defer client.CloseIdleConnections()
	var result struct {
		OK bool `json:"ok"`
	}
	if err := transport.DoJSON(context.Background(), client, http.MethodGet, server.URL, nil, nil, &result, 1024); err != nil || !result.OK {
		t.Fatalf("trusted enterprise CA: %+v %v", result, err)
	}
	untrusted := transport.NewClient(transport.Options{AllowPrivateHosts: []string{"127.0.0.1"}})
	defer untrusted.CloseIdleConnections()
	if err := transport.DoJSON(context.Background(), untrusted, http.MethodGet, server.URL, nil, nil, &result, 1024); err == nil {
		t.Fatal("untrusted certificate accepted")
	}
}

// The local peers model only external HTTP behavior. These tests catch missing
// SSRF guards, unbounded downloads and auth-after-body regressions, which ordinary
// successful-request tests miss. No test-only seams are used.
func TestClientDeniesPrivateDestinationUnlessExplicitlyConfigured(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if _, err := io.WriteString(w, `{"id":"00042"}`); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	var result struct {
		ID string `json:"id"`
	}
	client := transport.NewClient(transport.Options{})
	err := transport.DoJSON(context.Background(), client, http.MethodGet, server.URL, nil, nil, &result, 1024)
	if !errors.Is(err, transport.ErrUnsafeURL) || calls.Load() != 0 {
		t.Fatalf("private request: calls=%d err=%v", calls.Load(), err)
	}
	client = transport.NewClient(transport.Options{AllowPrivateHosts: []string{"127.0.0.1"}})
	if err := transport.DoJSON(context.Background(), client, http.MethodGet, server.URL, nil, nil, &result, 1024); err != nil {
		t.Fatal(err)
	}
	if result.ID != "00042" || calls.Load() != 1 {
		t.Fatalf("response=%+v calls=%d", result, calls.Load())
	}
}

func TestClientBlocksCrossOriginRedirectAndBoundsResponse(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, target.URL, http.StatusFound)
			return
		}
		if _, err := io.WriteString(w, strings.Repeat("x", 100)); err != nil {
			t.Error(err)
		}
	}))
	defer origin.Close()
	client := transport.NewClient(transport.Options{AllowPrivateHosts: []string{"127.0.0.1"}})
	err := transport.DoJSON(context.Background(), client, http.MethodGet, origin.URL+"/redirect", nil, nil, nil, 10)
	if err == nil || redirected.Load() != 0 {
		t.Fatalf("redirect: calls=%d err=%v", redirected.Load(), err)
	}
	err = transport.DoJSON(context.Background(), client, http.MethodGet, origin.URL, nil, nil, nil, 10)
	if !errors.Is(err, transport.ErrResponseTooLarge) {
		t.Fatalf("size limit: %v", err)
	}
}

func TestDoJSONPropagatesCancellationAndRedactsHTTPFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		if _, err := io.WriteString(w, "private-response-token"); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	client := transport.NewClient(transport.Options{AllowPrivateHosts: []string{"127.0.0.1"}})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := transport.DoJSON(ctx, client, http.MethodGet, server.URL, nil, nil, nil, 1024); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	err := transport.DoJSON(context.Background(), client, http.MethodGet, server.URL, nil, nil, nil, 1024)
	var failure *transport.HTTPError
	if !errors.As(err, &failure) || failure.Status != 429 || failure.RetryAfter != 7*time.Second {
		t.Fatalf("HTTP failure = %v", err)
	}
	if strings.Contains(err.Error(), "private-response-token") {
		t.Fatal("error leaked remote body")
	}
}

type trackedReader struct{ reads int }

func (r *trackedReader) Read([]byte) (int, error) { r.reads++; return 0, io.EOF }

func TestRouteAuthenticatesBeforeBodyAndEnforcesLimit(t *testing.T) {
	body := &trackedReader{}
	request := httptest.NewRequest(http.MethodPost, "/", body)
	response := httptest.NewRecorder()
	called := false
	handler := transport.RouteHandler(model.HTTPRoute{
		MaxBodyBytes: 4,
		Authorize:    func(*http.Request) error { return errors.New("invalid credential") },
		Handler:      http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }),
	})
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || body.reads != 0 || called {
		t.Fatalf("unauthorized: status=%d reads=%d called=%v", response.Code, body.reads, called)
	}
	handler = transport.RouteHandler(model.HTTPRoute{MaxBodyBytes: 4, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			http.Error(w, "request_too_large", http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})})
	request = httptest.NewRequest(http.MethodPost, "/", strings.NewReader("12345"))
	request.ContentLength = -1 // Exercise streaming bodies without Content-Length.
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("stream size status = %d", response.Code)
	}
}
