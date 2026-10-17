package wechat

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/relanox/relanox/internal/channels/internal/channeltest"
)

// Pairing cancellation must remove the reserved output or report why it could
// not. An open Windows reader denies deletion even after Login closes its own
// handle. Existing pairing tests cover an already-existing file, not reservation
// cleanup. The event callback and actual filesystem need no production-only seam.
func TestCanceledPairingReportsReservationCleanup(t *testing.T) {
	for _, fixture := range []struct {
		name string
		lock bool
	}{{name: "removed"}, {name: "locked", lock: true}} {
		t.Run(fixture.name, func(t *testing.T) {
			if fixture.lock && runtime.GOOS != "windows" {
				t.Skip("open file handles prevent deletion on Windows")
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			output := filepath.Join(t.TempDir(), "credentials.json")
			var reader *os.File
			t.Cleanup(func() {
				if reader != nil {
					if err := reader.Close(); err != nil {
						t.Error(err)
					}
				}
			})
			// Current native QR response, as in Tencent/openclaw-weixin
			// src/auth/login-qr.ts and this package's QR protocol fixture.
			// https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/ilink/bot/get_bot_qrcode" {
					t.Errorf("unexpected native request: %s", r.URL.Path)
					w.WriteHeader(404)
					return
				}
				channeltest.WriteResponse(t, w, `{"qrcode":"public-qr","qrcode_img_content":"https://weixin.qq.com/fixture"}`)
			}))
			defer peer.Close()
			err := Login(ctx, LoginOptions{APIBase: peer.URL, AllowInsecureLoopback: true, Output: output, Event: func(event map[string]any) {
				if event["event"] != "wechat_qrcode" {
					return
				}
				if fixture.lock {
					var err error
					reader, err = os.Open(output)
					if err != nil {
						t.Fatal(err)
					}
				}
				cancel()
			}})
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("pairing cancellation lost: %v", err)
			}
			assertReservationCleanup(t, output, fixture.lock, err)
		})
	}
}

func assertReservationCleanup(t *testing.T, path string, locked bool, err error) {
	t.Helper()
	if locked {
		var cleanup *os.PathError
		if !errors.As(err, &cleanup) || cleanup.Op != "remove" || cleanup.Path != path {
			t.Fatalf("reserved-file removal failure lost: %v", err)
		}
		return
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("cancelled pairing left reserved output: %v", statErr)
	}
}
