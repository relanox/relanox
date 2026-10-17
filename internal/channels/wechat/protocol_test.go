package wechat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Protects lossless native IDs and authentication boundaries with documented
// external wire data. Float64 decoding would corrupt IDs; copying authenticated
// API headers onto login polling would leak credentials. No existing Go coverage
// or artificial production seam is used.
func TestNativeIDsAndPairingHTTP(t *testing.T) {
	// https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts
	var updates Updates
	if err := json.Unmarshal([]byte(`{"msgs":[{"message_id":18446744073709551615,"item_list":[{"type":3,"msg_id":"42","voice_item":{"encode_type":6}}]}],"get_updates_buf":"opaque-cursor"}`), &updates); err != nil {
		t.Fatal(err)
	}
	if updates.Messages[0].ID != "18446744073709551615" || updates.Messages[0].Items[0].Type != 3 {
		t.Fatalf("native IDs or numbering changed: %+v", updates)
	}
	var gotBegin, gotStatus, gotUpdates bool
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("iLink-App-Id") != "bot" {
			t.Error("missing native app header")
		}
		switch r.URL.Path {
		case "/ilink/bot/get_bot_qrcode":
			gotBegin = true
			if r.Method != http.MethodPost || r.URL.Query().Get("bot_type") != "3" || r.Header.Get("Authorization") != "" {
				t.Error("incorrect QR boundary")
			}
			fmt.Fprint(w, `{"qrcode":"public-qr","qrcode_img_content":"https://weixin.qq.com/fixture"}`)
		case "/ilink/bot/get_qrcode_status":
			gotStatus = true
			if r.Method != http.MethodGet || r.URL.Query().Get("verify_code") != "123456" || r.Header.Get("Authorization") != "" || r.Header.Get("X-WECHAT-UIN") != "" {
				t.Error("poll leaked authenticated headers or lost verification")
			}
			fmt.Fprint(w, `{"status":"need_verifycode"}`)
		case "/ilink/bot/getupdates":
			gotUpdates = true
			if r.Header.Get("Authorization") != "Bearer public-fixture-token" || r.Header.Get("AuthorizationType") != "ilink_bot_token" || r.Header.Get("X-WECHAT-UIN") == "" {
				t.Error("missing native API credentials")
			}
			fmt.Fprint(w, `{"ret":0,"msgs":[],"get_updates_buf":"committed"}`)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer peer.Close()
	options := LoginOptions{APIBase: peer.URL, AllowInsecureLoopback: true}
	qr, err := BeginLogin(context.Background(), options)
	if err != nil || qr.Code != "public-qr" {
		t.Fatalf("QR: %+v %v", qr, err)
	}
	status, err := PollLogin(context.Background(), options, qr.Code, "123456")
	if err != nil || status.Status != "need_verifycode" {
		t.Fatalf("status: %+v %v", status, err)
	}
	client := &Client{APIBase: peer.URL, Token: func() string { return "public-fixture-token" }}
	if err = client.Post(context.Background(), "getupdates", map[string]any{"get_updates_buf": "prior"}, &updates, time.Second); err != nil {
		t.Fatal(err)
	}
	if !gotBegin || !gotStatus || !gotUpdates || updates.Cursor != "committed" {
		t.Fatal("native requests did not complete")
	}
}
