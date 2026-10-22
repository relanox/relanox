package speech_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/speech"
)

// Transport timeouts must produce the same stable timeout fallback as the
// per-clip context budget, even when that context has not expired. The existing
// eight-second budget test races the SDK's equal client timeout and cannot
// reliably exercise the transport-first branch. This real TLS peer stalls the
// documented SentenceRecognition response; the production HTTPClient option
// selects a shorter response-header timeout without adding a test-only seam.
// SDK error wrapping: tencentcloud/common v1.3.193 netretry.go and errors/errors.go.
func TestRecognitionTransportTimeoutPreservesFallbackAndCancelsIO(t *testing.T) {
	peer := newASRPeer(t, "", true)
	client := peer.client()
	routed := client.Transport.(peerTransport)
	base := routed.base.(*http.Transport).Clone()
	base.ResponseHeaderTimeout = 250 * time.Millisecond
	defer base.CloseIdleConnections()
	routed.base = base
	client.Transport = routed
	preparer, err := speech.New(speechConfig(), speech.Options{HTTPClient: client, ResolveSecret: func(model.SecretRef) (string, error) { return "fixture", nil }})
	if err != nil {
		t.Fatal(err)
	}
	input := speechInput(t, preparer, []model.StoredMedia{{Reference: model.MediaReference{ID: "held", Kind: model.Audio, MIMEType: "audio/wav"}, Data: []byte("abc")}})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	output, err := preparer.Process(ctx, input)
	if err != nil || ctx.Err() != nil || output.Text != input.Message.Text || !strings.Contains(string(output.Data), `"errorCode":"timeout"`) {
		t.Fatalf("transport timeout lost fallback: output=%+v error=%v parent=%v", output, err, ctx.Err())
	}
	select {
	case <-peer.cancelled:
	case <-time.After(time.Second):
		t.Fatal("transport timeout did not cancel real HTTP")
	}
}

// A lost connection is a provider outage, not proof of a deadline. Keep this
// adjacent to the timeout regression to prevent classifying every SDK-wrapped
// network failure as timeout. Closing a real peer connection creates EOF rather
// than a mock that supplies the classification under test.
func TestRecognitionConnectionLossRemainsProviderUnavailable(t *testing.T) {
	peer := newASRPeer(t, "", true)
	preparer := newConcurrentPreparer(t, peer)
	input := speechInput(t, preparer, []model.StoredMedia{{Reference: model.MediaReference{ID: "held", Kind: model.Audio, MIMEType: "audio/wav"}, Data: []byte("abc")}})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	done := make(chan model.PreparationOutput, 1)
	go func() {
		output, err := preparer.Process(ctx, input)
		if err != nil {
			t.Error(err)
		}
		done <- output
	}()
	select {
	case <-peer.requests:
	case <-time.After(2 * time.Second):
		t.Fatal("request never reached TLS peer")
	}
	peer.server.CloseClientConnections()
	select {
	case output := <-done:
		if ctx.Err() != nil || output.Text != input.Message.Text || !strings.Contains(string(output.Data), `"errorCode":"provider_unavailable"`) {
			t.Fatalf("connection loss misclassified: output=%+v parent=%v", output, ctx.Err())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("closed connection did not unblock recognition")
	}
}
