package qq

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type chunkPeer struct {
	t               *testing.T
	mu              sync.Mutex
	cos             string
	expires         time.Time
	prepared        bool
	parts, finished []int
	message         *nativeSend
}

func (p *chunkPeer) native(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/app/getAppAccessToken":
		writePeerResponse(p.t, w, `{"access_token":"native","expires_in":7200}`)
	case "/v2/groups/group/upload_prepare":
		p.prepare(w, r)
	case "/v2/groups/group/upload_part_finish":
		p.finish(w, r)
	case "/v2/groups/group/files":
		var body struct {
			ID string `json:"upload_id"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.ID != "upload-native" {
			p.t.Error("completion upload ID lost")
		}
		writePeerResponse(p.t, w, `{"file_uuid":"native","file_info":"uploaded-large","ttl":3600}`)
	case "/v2/groups/group/messages":
		var body nativeSend
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			p.t.Error(err)
		}
		p.mu.Lock()
		p.message = &body
		p.mu.Unlock()
		writePeerResponse(p.t, w, `{"id":"sent"}`)
	default:
		p.t.Errorf("unexpected native path: %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

func (p *chunkPeer) prepare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type   int    `json:"file_type"`
		Name   string `json:"file_name"`
		Size   int64  `json:"file_size"`
		MD5    string `json:"md5"`
		SHA1   string `json:"sha1"`
		Prefix string `json:"md5_10m"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		p.t.Error(err)
		return
	}
	if body.Type != 4 || body.Name != "a_b.bin" || body.Size != 6*1024*1024 {
		p.t.Error("prepare file type/name/size changed")
	}
	if body.MD5 != "0df68495b5ef53a8ce2a9d4076cc6252" || body.SHA1 != "91eac35ccff0868a555cc9c4cd6ddfb8d2cfebf4" || body.Prefix != "0df68495b5ef53a8ce2a9d4076cc6252" {
		p.t.Error("native required hashes lost")
	}
	p.mu.Lock()
	p.prepared = true
	p.mu.Unlock()
	writePeerResponse(p.t, w, fmt.Sprintf(`{"upload_id":"upload-native","block_size":5242880,"parts":[{"index":1,"presigned_url":%q},{"index":2,"presigned_url":%q}]}`, p.cos+"/1?signature=public", p.cos+"/2?signature=public"))
}

func (p *chunkPeer) finish(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID    string `json:"upload_id"`
		Index int    `json:"part_index"`
		Size  int    `json:"block_size"`
		MD5   string `json:"md5"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		p.t.Error(err)
		return
	}
	wantSize := 5 * 1024 * 1024
	wantMD5 := "79b281060d337b9b2b84ccf390adcf74"
	if body.Index == 2 {
		wantSize = 1024 * 1024
		wantMD5 = "7202826a7791073fe2787f0c94603278"
	}
	if body.ID != "upload-native" || body.Index < 1 || body.Index > 2 || body.Size != wantSize || body.MD5 != wantMD5 {
		p.t.Errorf("part finish: %+v", body)
	}
	p.mu.Lock()
	p.finished = append(p.finished, body.Index)
	p.mu.Unlock()
	writePeerResponse(p.t, w, `{"code":0}`)
}

func (p *chunkPeer) upload(w http.ResponseWriter, r *http.Request) {
	index, _ := strconv.Atoi(r.URL.Path[1:])
	data, err := io.ReadAll(r.Body)
	if err != nil {
		p.t.Error(err)
		return
	}
	if r.Method != http.MethodPut || r.Header.Get("Authorization") != "" || r.URL.Query().Get("signature") != "public" {
		p.t.Error("COS request credentials/method changed")
	}
	want := 5 * 1024 * 1024
	if index == 2 {
		want = 1024 * 1024
	}
	if len(data) != want || bytes.Count(data, []byte("a")) != want {
		p.t.Error("native part bytes changed")
	}
	p.mu.Lock()
	p.parts = append(p.parts, index)
	p.mu.Unlock()
	if index == 1 && !p.expires.IsZero() {
		time.Sleep(max(0, time.Until(p.expires.Add(10*time.Millisecond))))
	}
	w.WriteHeader(200)
}

func chunkFixture(t *testing.T, trusted bool) (*Channel, *chunkPeer) {
	t.Helper()
	p := &chunkPeer{t: t}
	cos := httptest.NewTLSServer(http.HandlerFunc(p.upload))
	t.Cleanup(cos.Close)
	p.cos = cos.URL
	roots := x509.NewCertPool()
	roots.AddCert(cos.Certificate())
	cfg := Config{AppID: "app", ClientSecret: model.SecretRef{Env: "SECRET"}}
	if trusted {
		cfg.TrustedUploadOrigins = []string{cos.URL}
	}
	c, err := New(testHost{}, model.AccountConfig{ID: "account", Channel: model.QQ, Config: common.Data(cfg)}, common.Options{HTTPClient: redirectedClient(t, http.HandlerFunc(p.native)), TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, ResolveSecret: func(model.SecretRef) (string, error) { return "public", nil }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	return c, p
}

func chunkInput(t *testing.T, c *Channel, expires time.Time) model.SendInput {
	input := sendInput(c, "group")
	input.Target.ChatID = "group"
	at := expires.Add(-5 * time.Minute).UnixMilli()
	var target targetData
	if err := json.Unmarshal(input.Target.Data, &target); err != nil {
		t.Error(err)
	}
	target.MessageAt = &at
	input.Target.Data = common.Data(target)
	ref := model.MediaReference{ID: "media", Kind: model.File, MIMEType: "application/octet-stream", FileName: "a/b.bin", Size: 6 * 1024 * 1024}
	input.Chunk.Media = &ref
	input.Media = &model.StoredMedia{Reference: ref, Data: bytes.Repeat([]byte("a"), int(ref.Size))}
	return input
}

// Protects the real native prepare/PUT/finish/complete protocol and rechecks the
// passive window after upload. Off-by-one parts, wrong hashes or a cached msg_id
// fail actual wire traffic; small-file tests never cover this sequence. COS uses
// an explicit administrator origin and real TLS roots, with no network bypass.
func TestNativeChunkedUploadRechecksPassiveWindow(t *testing.T) {
	// Verified native implementation: @tencent-connect/qqbot-nodejs 1.0.5
	// protocol/api/media-chunked.ts, routes.ts, protocol/types.ts.
	// https://github.com/tencent-connect/qqbot-nodejs
	c, p := chunkFixture(t, true)
	p.expires = time.Now().Add(time.Second)
	result, err := c.Send(context.Background(), chunkInput(t, c, p.expires))
	if err != nil || result.Status != model.Sent {
		t.Fatalf("chunked send: %+v %v", result, err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if fmt.Sprint(p.parts) != "[1 2]" || fmt.Sprint(p.finished) != "[1 2]" || p.message == nil {
		t.Fatal("chunk completion order lost")
	}
	body := p.message
	if body.Type != 7 || body.Media == nil || body.Media.FileInfo != "uploaded-large" || body.MessageID != "" || body.Sequence != 1 {
		t.Fatalf("expired native media envelope: %+v", body)
	}
	if body.Reference == nil || body.Reference.MessageID != "native-index" {
		t.Fatal("explicit quote index lost")
	}
}

func TestPresignedUploadCannotGrantPrivateNetworkAccess(t *testing.T) {
	c, p := chunkFixture(t, false)
	result, err := c.Send(context.Background(), chunkInput(t, c, time.Now().Add(time.Hour)))
	if err != nil || result.Status != model.Rejected || result.ErrorCode != "invalid_upload_part_origin" {
		t.Fatalf("private COS: %+v %v", result, err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.prepared || len(p.parts) != 0 || p.message != nil {
		t.Fatal("native response granted private upload access")
	}
}

// writePeerResponse fails the fixture when its native response cannot be delivered.
func writePeerResponse(t *testing.T, w http.ResponseWriter, body string) {
	t.Helper()
	if _, err := io.WriteString(w, body); err != nil {
		t.Error(err)
	}
}
