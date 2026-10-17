package cli

import (
	"bufio"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

type failedOutput struct{ err error }

func (w failedOutput) Write([]byte) (int, error) { return 0, w.err }

// A broken pipe must fail human status output just as JSON output already does.
// Existing CLI tests collect output in a buffer, which never fails. This uses
// the real command and durable fixture; the writer only models an I/O failure.
func TestStatusReportsHumanOutputFailure(t *testing.T) {
	path, _ := adminFixture(t)
	failure := errors.New("output unavailable")
	err := Run(context.Background(), []string{"--config", path, "status"}, Options{In: strings.NewReader(""), Out: failedOutput{failure}, Err: io.Discard})
	if !errors.Is(err, failure) {
		t.Fatalf("status error = %v, want output failure", err)
	}
}

// An invisible prompt must not consume scripted input or continue setup.
// The production streams already provide the seam; no extra hook is needed.
func TestPromptStopsBeforeReadingWhenOutputFails(t *testing.T) {
	failure := errors.New("prompt unavailable")
	input := strings.NewReader("credential\n")
	c := &command{options: Options{In: input, Err: failedOutput{failure}}, reader: bufio.NewReader(input)}
	if _, err := c.prompt("Credential", "", false); !errors.Is(err, failure) {
		t.Fatalf("prompt error = %v, want output failure", err)
	}
	if input.Len() != len("credential\n") {
		t.Fatal("failed prompt consumed input")
	}
}
