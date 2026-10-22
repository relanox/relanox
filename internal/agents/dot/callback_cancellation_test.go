package dot

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/model"
)

// An already cancelled notification has no remote effect and must remain safe
// to retry. Existing receipt tests use live contexts and cannot distinguish it
// from a lost callback receipt. This exercises the production callback dispatch
// against the existing real TLS protocol peer; no new production seam is used.
// The signing secret is the Standard Webhooks official Go fixture already
// verified in protocol_test.go:
// https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/go/webhook_test.go
func TestCallbackCancelledBeforeTransmissionRemainsRetryable(t *testing.T) {
	peer := newCallbackPeer(t)
	agent := &Agent{deps: agentmcp.Dependencies{HTTPClient: peer.client}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	sub := subscription{ID: "sub-native", URL: "https://connectors.api.openai.com/native-callback", Secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"}
	result := agent.dispatchSubscription(ctx, model.StateEntry{}, sub, "evt-native", []byte(`{}`))
	if result.Status != model.Retryable || result.ErrorCode != "dot_dispatch_cancelled" {
		t.Fatalf("unsent cancellation classified as %+v", result)
	}
	if peer.events.Load() != 0 || peer.challenges.Load() != 0 {
		t.Fatal("cancelled callback reached peer")
	}
}

// Once a real callback peer reads the body, cancellation cannot prove the event
// was rejected. Preserve Unknown so recovery cannot automatically duplicate it.
func TestCallbackCancelledAfterTransmissionRemainsUnknown(t *testing.T) {
	received := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		if err != nil || string(data) != `{}` {
			t.Error("callback body unavailable", err)
			w.WriteHeader(400)
			return
		}
		close(received)
		<-r.Context().Done()
	}))
	defer server.Close()
	remote, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = remote.Hostname()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, remote.Host)
	}
	defer transport.CloseIdleConnections()
	agent := &Agent{deps: agentmcp.Dependencies{HTTPClient: &http.Client{Transport: transport}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := subscription{ID: "sub-native", URL: "https://connectors.api.openai.com/native-callback", Secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"}
	done := make(chan model.DispatchResult, 1)
	go func() { done <- agent.dispatchSubscription(ctx, model.StateEntry{}, sub, "evt-native", []byte(`{}`)) }()
	select {
	case <-received:
	case <-time.After(3 * time.Second):
		t.Fatal("callback never reached peer")
	}
	cancel()
	select {
	case result := <-done:
		if result.Status != model.Unknown || result.ErrorCode != "dot_callback_uncertain" {
			t.Fatalf("ambiguous callback classified as %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("callback ignored cancellation")
	}
}
