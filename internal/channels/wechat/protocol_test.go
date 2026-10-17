package wechat

import (
	"context"
	"crypto/aes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
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
	fixture := &pairingPeer{t: t}
	peer := httptest.NewServer(fixture)
	defer peer.Close()
	options := LoginOptions{APIBase: peer.URL, AllowInsecureLoopback: true, HTTP: peer.Client()}
	qr, err := BeginLogin(context.Background(), options)
	if err != nil || qr.Code != "public-qr" {
		t.Fatalf("QR: %+v %v", qr, err)
	}
	status, err := PollLogin(context.Background(), options, qr.Code, "123456")
	if err != nil || status.Status != "need_verifycode" {
		t.Fatalf("status: %+v %v", status, err)
	}
	client := &Client{APIBase: peer.URL, Token: func() string { return "public-fixture-token" }, HTTP: peer.Client()}
	if err = client.Post(context.Background(), "getupdates", map[string]any{"get_updates_buf": "prior"}, &updates, time.Second); err != nil {
		t.Fatal(err)
	}
	if !fixture.gotBegin || !fixture.gotStatus || !fixture.gotUpdates || updates.Cursor != "committed" {
		t.Fatal("native requests did not complete")
	}
}

func TestSessionExpirationPrecedesGenericResult(t *testing.T) {
	// Tencent monitor checks errcode=-14 even when the generic ret is nonzero.
	// https://github.com/Tencent/openclaw-weixin/blob/main/src/monitor/monitor.ts
	for _, body := range []string{`{"ret":-14}`, `{"ret":-1,"errcode":-14}`} {
		err := readJSON(&http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, new(map[string]any))
		var native *APIError
		if !errors.As(err, &native) || native.Code != -14 {
			t.Fatalf("session expiry lost for %s: %v", body, err)
		}
	}
}

// Protects outbound native upload and media envelope rather than matching two
// implementations of the same cipher. A wrong media_type or numeric len changes
// the real HTTP request. Prior pairing coverage never uploads bytes. No new seam.
func TestNativeFileUploadThroughSend(t *testing.T) {
	fixture := &fileUploadPeer{t: t}
	peer := httptest.NewServer(fixture)
	defer peer.Close()
	cfg := Config{BotID: "bot", BotToken: model.SecretRef{Env: "PUBLIC_FIXTURE"}, APIBaseURL: peer.URL, CDNBaseURL: peer.URL + "/c2c", AllowInsecureLoopback: true}
	channel, err := New(nil, model.AccountConfig{ID: "wechat", Channel: model.WeChat, Config: common.Data(cfg)}, common.Options{HTTPClient: peer.Client(), ResolveSecret: func(model.SecretRef) (string, error) { return "public-token", nil }})
	if err != nil {
		t.Fatal(err)
	}
	media := model.StoredMedia{Reference: model.MediaReference{ID: "asset", Kind: model.File, MIMEType: "application/octet-stream", FileName: "opaque file.bin", Size: 3}, Data: []byte("abc")}
	result, err := channel.Send(context.Background(), model.SendInput{Target: model.ReplyTarget{Channel: model.WeChat, AccountID: "wechat", ChatID: "alice", Data: common.Data(targetData{BotID: "bot", APIBaseURL: peer.URL, ContextToken: "public-context"})}, Chunk: model.DeliveryChunk{Media: &media.Reference, IdempotencyKey: "public-message"}, Media: &media})
	if err != nil || result.Status != model.Sent {
		t.Fatalf("send: %+v %v", result, err)
	}
	if !fixture.gotUpload || !fixture.gotSend || len(fixture.ciphertext) != 16 || len(fixture.key) != 16 {
		t.Fatal("native media transfer missing")
	}
	block, err := aes.NewCipher(fixture.key)
	if err != nil {
		t.Fatal(err)
	}
	plain := make([]byte, 16)
	block.Decrypt(plain, fixture.ciphertext)
	if string(plain[:3]) != "abc" || plain[15] != 13 {
		t.Fatalf("incorrect native AES ECB envelope: %x", plain)
	}
}

func TestLoginExplicitLoopbackAndExistingCredential(t *testing.T) {
	// Explicit insecure loopback is a production local testing option; using a
	// custom HTTP client here would conceal a broken option in the real CLI.
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writePeerResponse(t, w, `{"qrcode":"public-qr","qrcode_img_content":"https://weixin.qq.com/fixture"}`)
	}))
	defer peer.Close()
	if _, err := BeginLogin(context.Background(), LoginOptions{APIBase: peer.URL, AllowInsecureLoopback: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := BeginLogin(context.Background(), LoginOptions{APIBase: peer.URL}); err == nil {
		t.Fatal("implicit insecure login accepted")
	}
	filename := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(filename, []byte("preserved"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Login(context.Background(), LoginOptions{Output: filename}); err == nil {
		t.Fatal("existing credentials overwritten")
	}
	raw, err := os.ReadFile(filename)
	if err != nil || string(raw) != "preserved" {
		t.Fatal("existing credentials changed")
	}
}

type pairingPeer struct {
	t                               *testing.T
	gotBegin, gotStatus, gotUpdates bool
}

func (p *pairingPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Header.Get("iLink-App-Id") != "bot" {
		p.t.Error("missing native app header")
	}
	switch r.URL.Path {
	case "/ilink/bot/get_bot_qrcode":
		p.gotBegin = true
		if r.Method != http.MethodPost || r.URL.Query().Get("bot_type") != "3" || r.Header.Get("Authorization") != "" {
			p.t.Error("incorrect QR boundary")
		}
		writePeerResponse(p.t, w, `{"qrcode":"public-qr","qrcode_img_content":"https://weixin.qq.com/fixture"}`)
	case "/ilink/bot/get_qrcode_status":
		p.gotStatus = true
		if r.Method != http.MethodGet || r.URL.Query().Get("verify_code") != "123456" || r.Header.Get("Authorization") != "" || r.Header.Get("X-WECHAT-UIN") != "" {
			p.t.Error("poll leaked authenticated headers or lost verification")
		}
		writePeerResponse(p.t, w, `{"status":"need_verifycode"}`)
	case "/ilink/bot/getupdates":
		p.gotUpdates = true
		if r.Header.Get("Authorization") != "Bearer public-fixture-token" || r.Header.Get("AuthorizationType") != "ilink_bot_token" || r.Header.Get("X-WECHAT-UIN") == "" {
			p.t.Error("missing native API credentials")
		}
		writePeerResponse(p.t, w, `{"ret":0,"msgs":[],"get_updates_buf":"committed"}`)
	default:
		p.t.Errorf("unexpected request %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

type fileUploadPeer struct {
	t                  *testing.T
	key, ciphertext    []byte
	gotUpload, gotSend bool
}

func (p *fileUploadPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/ilink/bot/getuploadurl":
		var body struct {
			AESKey    string `json:"aeskey"`
			MediaType int    `json:"media_type"`
			RawSize   int    `json:"rawsize"`
			RawMD5    string `json:"rawfilemd5"`
			FileSize  int    `json:"filesize"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			p.t.Error(err)
		}
		if body.MediaType != 3 || body.RawSize != 3 || body.FileSize != 16 || body.RawMD5 != "900150983cd24fb0d6963f7d28e17f72" {
			p.t.Errorf("incorrect native upload: %+v", body)
		}
		p.key, _ = hex.DecodeString(body.AESKey)
		writePeerResponse(p.t, w, `{"upload_param":"public-upload-ticket"}`)
	case "/c2c/upload":
		p.gotUpload = true
		p.ciphertext, _ = io.ReadAll(r.Body)
		if r.URL.Query().Get("encrypted_query_param") != "public-upload-ticket" || r.Header.Get("Authorization") != "" {
			p.t.Error("incorrect CDN upload boundary")
		}
		w.Header().Set("x-encrypted-param", "public-download-ticket")
	case "/ilink/bot/sendmessage":
		p.gotSend = true
		var body struct {
			Message Message `json:"msg"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			p.t.Error(err)
		}
		if len(body.Message.Items) != 1 || body.Message.Items[0].Type != 4 || body.Message.Items[0].File == nil {
			p.t.Error("missing native file item")
			return
		}
		if body.Message.ClientID != "public-message" || body.Message.ContextToken != "public-context" {
			p.t.Error("native idempotency/context changed")
		}
		file := body.Message.Items[0].File
		if file.Length != "3" || file.FileName != "opaque file.bin" || file.Media.Query != "public-download-ticket" {
			p.t.Errorf("file identifiers/length changed: %+v", file)
		}
		writePeerResponse(p.t, w, `{"ret":0}`)
	default:
		p.t.Errorf("unexpected request: %s", r.URL.Path)
		w.WriteHeader(404)
	}
}
