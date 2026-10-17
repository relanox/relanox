package common

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSDKHTTPPreservesNativeStatusAndRejectsRedirect(t *testing.T) {
	// LINE retry responses retain their native 409 and accepted-request header.
	// https://developers.line.biz/en/reference/messaging-api/#send-push-message
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			w.Header().Set("Location", "/unexpected")
			w.WriteHeader(http.StatusFound)
			return
		}
		if r.URL.Path != "/push" {
			t.Error("followed native redirect")
		}
		w.Header().Set("X-Line-Accepted-Request-Id", "accepted")
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"message":"already accepted"}`)
	}))
	defer peer.Close()
	client := SDKHTTPClient(peer.Client(), t.Context(), 1024)
	for _, path := range []string{"/push", "/redirect"} {
		response, err := client.Post(peer.URL+path, "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if path == "/push" && (response.StatusCode != 409 || response.Header.Get("X-Line-Accepted-Request-Id") != "accepted" || string(body) != `{"message":"already accepted"}`) {
			t.Fatalf("lost native rejection: %d %q", response.StatusCode, body)
		}
		if path == "/redirect" && response.StatusCode != 302 {
			t.Fatalf("redirect status = %d", response.StatusCode)
		}
	}
}

func TestSDKHTTPLimitsChunkedResponse(t *testing.T) {
	// HTTP chunked bodies have no declared length; the read budget still applies.
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		_, _ = io.WriteString(w, strings.Repeat("x", 65))
	}))
	defer peer.Close()
	response, err := SDKHTTPClient(peer.Client(), t.Context(), 64).Get(peer.URL)
	if response != nil {
		response.Body.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "media_too_large") {
		t.Fatalf("unbounded SDK response: %v", err)
	}
}

func TestSDKHTTPCancellationReachesResponseRead(t *testing.T) {
	// An SDK-created request without a context must inherit caller cancellation
	// while a real HTTP response is still arriving.
	started := make(chan struct{})
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer peer.Close()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		response, err := SDKHTTPClient(peer.Client(), ctx, 1024).Get(peer.URL)
		if response != nil {
			response.Body.Close()
		}
		finished <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("SDK request did not reach peer")
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("SDK cancellation = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("SDK response read ignored cancellation")
	}
}

func TestSDKHTTPCloseIdleConnectionsReachesPeer(t *testing.T) {
	// Wrapping a transport must preserve http.Client.CloseIdleConnections.
	closed := make(chan struct{}, 1)
	peer := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	peer.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			select {
			case closed <- struct{}{}:
			default:
			}
		}
	}
	peer.Start()
	defer peer.Close()
	client := SDKHTTPClient(peer.Client(), t.Context(), 1024)
	response, err := client.Get(peer.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	client.CloseIdleConnections()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("SDK transport retained its idle connection")
	}
}

func TestSDKHTTPRejectedRequestClosesBody(t *testing.T) {
	// The RoundTripper contract requires closing request bodies even on errors.
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	request, err := http.NewRequest(http.MethodPost, "https://unused.example", reader)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	client := SDKHTTPClient(nil, ctx, 1024)
	_, err = client.Transport.RoundTrip(request)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("preflight error = %v", err)
	}
	finished := make(chan error, 1)
	go func() {
		_, err := writer.Write([]byte("body"))
		finished <- err
	}()
	select {
	case err := <-finished:
		if !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("rejected request body stayed open: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("rejected SDK request did not close its body")
	}
}
