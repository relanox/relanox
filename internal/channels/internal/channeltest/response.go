// Package channeltest provides checked output for native protocol fixtures.
package channeltest

import (
	"encoding/json"
	"io"
	"testing"
)

// WriteResponse reports failures writing a native fixture response.
func WriteResponse(t testing.TB, w io.Writer, body string) {
	t.Helper()
	if _, err := io.WriteString(w, body); err != nil {
		t.Error(err)
	}
}

// WriteJSON reports failures encoding or writing a native fixture response.
func WriteJSON(t testing.TB, w io.Writer, body any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Error(err)
	}
}
