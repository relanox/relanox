package common

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/model"
)

// A response timeout after a send cannot confirm delivery. Other 4xx errors
// are definitive rejections; the shared classifier previously conflated them.
// Existing native tests exercise adapters with dedicated timeout classifiers.
// No production-only seam is needed.
func TestFailurePreservesUncertainSendTimeout(t *testing.T) {
	for _, preparing := range []bool{false, true} {
		got := Failure(&HTTPError{Status: http.StatusRequestTimeout}, preparing)
		want := model.Unknown
		if preparing {
			want = model.Retryable
		}
		if got.Status != want {
			t.Fatalf("preparing=%v status=%s, want %s", preparing, got.Status, want)
		}
	}
}

// HTTP status and Retry-After remain authoritative even when a gateway returns
// an oversized diagnostic page. Existing peers return only short error bodies.
// RFC 9110 sections 10.2.3 and 15 describe these native HTTP fields; this peer
// models HTTP only and does not emulate routing or delivery decisions.
func TestDoPreservesOversizedErrorStatus(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Retry-After", "7")
			if !chunked {
				w.Header().Set("Content-Length", "65537")
			}
			w.WriteHeader(http.StatusTooManyRequests)
			if chunked {
				w.(http.Flusher).Flush()
			}
			_, _ = io.WriteString(w, strings.Repeat("x", 65537))
		}))
		request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, peer.URL, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, _, err = Do(peer.Client(), request, MaxJSONBytes)
		peer.Close()
		var native *HTTPError
		if !errors.As(err, &native) || native.Status != 429 || native.Header.Get("Retry-After") != "7" || len(native.Body) > 65536 {
			t.Fatalf("chunked=%v lost bounded native status: %v", chunked, err)
		}
	}
}
