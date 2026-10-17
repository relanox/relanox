package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	larktypes "github.com/larksuite/oapi-sdk-go/v3/channel/types"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type mediaPeer struct {
	t             *testing.T
	tokens, sends int
	rejectToken   bool
	types         []string
	durations     []string
}

func (p *mediaPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/open-apis/auth/v3/tenant_access_token/internal":
		p.tokens++
		writePeerResponse(p.t, w, fmt.Sprintf(`{"code":0,"tenant_access_token":"native-%d","expire":7200}`, p.tokens))
	case "/open-apis/bot/v3/info":
		writePeerResponse(p.t, w, `{"code":0,"bot":{"open_id":"ou_bot"}}`)
	case "/open-apis/im/v1/files":
		if err := r.ParseMultipartForm(1024); err != nil {
			p.t.Error(err)
			return
		}
		defer func() { _ = r.MultipartForm.RemoveAll() }()
		p.types = append(p.types, r.FormValue("file_type"))
		p.durations = append(p.durations, r.FormValue("duration"))
		if len(r.MultipartForm.File["file"]) != 1 {
			p.t.Error("native file field missing")
		}
		writePeerResponse(p.t, w, `{"code":0,"data":{"file_key":"file_native"}}`)
	case "/open-apis/im/v1/messages":
		p.sends++
		if p.rejectToken {
			p.rejectToken = false
			writePeerResponse(p.t, w, `{"code":99991663}`)
			return
		}
		var body struct {
			Type    string `json:"msg_type"`
			Content string `json:"content"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			p.t.Error("invalid native envelope")
			return
		}
		var content map[string]any
		if json.Unmarshal([]byte(body.Content), &content) != nil {
			p.t.Error("content must be JSON inside string")
			return
		}
		if body.Type != "post" && content["file_key"] != "file_native" {
			p.t.Error("file key lost")
		}
		writePeerResponse(p.t, w, `{"code":0,"data":{"message_id":"om_sent"}}`)
	case "/open-apis/im/v1/messages/om_source/resources/file_json":
		if r.URL.Query().Get("type") != "file" || r.Header.Get("Authorization") == "" {
			p.t.Error("native resource scope missing")
		}
		writePeerResponse(p.t, w, `{"code":123,"payload":"file content"}`)
	default:
		p.t.Errorf("unexpected native path: %s", r.URL.Path)
		w.WriteHeader(404)
	}
}

func mediaFixture(t *testing.T) (*Channel, *mediaPeer) {
	t.Helper()
	p := &mediaPeer{t: t}
	server := httptest.NewServer(p)
	t.Cleanup(server.Close)
	base, _ := url.Parse(server.URL)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme = base.Scheme
		copy.URL.Host = base.Host
		return http.DefaultTransport.RoundTrip(copy)
	})}
	cfg := Config{AppID: "app", TenantKey: "tenant", AppSecret: model.SecretRef{Env: "APP"}, VerificationToken: model.SecretRef{Env: "VERIFY"}, EncryptKey: model.SecretRef{Env: "ENCRYPT"}}
	c, err := New(outboundHost{}, model.AccountConfig{ID: "account", Channel: model.Feishu, Config: common.Data(cfg)}, common.Options{HTTPClient: client, ResolveSecret: func(model.SecretRef) (string, error) { return "public-secret", nil }})
	if err != nil {
		t.Fatal(err)
	}
	return c, p
}

func mediaInput() model.SendInput {
	return model.SendInput{Target: model.ReplyTarget{Channel: model.Feishu, AccountID: "account", ChatID: "oc_chat", Data: common.Data(targetData{AppID: "app", TenantKey: "tenant", BotID: "ou_bot", APIBaseURL: "https://open.feishu.cn"})}, Chunk: model.DeliveryChunk{Text: "text", IdempotencyKey: "chunk"}}
}

// Protects native media units/types and treating downloaded JSON as file bytes.
// Interpreting file bytes as an API envelope loses valid attachments; generated
// auth types can cache an empty token. Existing text/reply tests miss both.
// The peer models only native HTTP and introduces no production seam.
func TestMediaMultipartAndOpaqueResourceBytes(t *testing.T) {
	// Verified SDK: oapi-sdk-go v3.12.2 service/im/v1/model.go CreateFileReqBody;
	// channel/normalize duration parsing preserves milliseconds.
	// https://open.feishu.cn/document/server-docs/im-v1/file/create
	// https://open.feishu.cn/document/server-docs/im-v1/message-resource/get
	c, p := mediaFixture(t)
	duration := int64(1234)
	for _, kind := range []model.MediaKind{model.Audio, model.Video, model.File} {
		input := mediaInput()
		input.Chunk.Text = ""
		ref := model.MediaReference{ID: "media", Kind: kind, FileName: "resource", MIMEType: "application/octet-stream", DurationMS: &duration, Size: 3}
		input.Chunk.Media = &ref
		input.Media = &model.StoredMedia{Reference: ref, Data: []byte("raw")}
		result, err := c.Send(context.Background(), input)
		if err != nil || result.Status != model.Sent {
			t.Fatalf("media send: %+v %v", result, err)
		}
	}
	if fmt.Sprint(p.types) != "[opus mp4 stream]" || fmt.Sprint(p.durations) != "[1234 1234 1234]" {
		t.Fatalf("native fields: %v %v", p.types, p.durations)
	}
	resources, err := c.downloadResources(context.Background(), "om_source", []larktypes.Resource{{Type: "file", FileKey: "file_json", FileName: "data.json"}})
	if err != nil || len(resources) != 1 {
		t.Fatalf("download: %+v %v", resources, err)
	}
	if string(resources[0].Data) != `{"code":123,"payload":"file content"}` || resources[0].MIMEType != "application/json" {
		t.Fatal("resource bytes were parsed or changed")
	}
}

func TestRejectedTokenIsInvalidatedWithoutSendReplay(t *testing.T) {
	c, p := mediaFixture(t)
	p.rejectToken = true
	result, err := c.Send(context.Background(), mediaInput())
	if err != nil || result.Status != model.Retryable || result.ErrorCode != "feishu_token_invalid" || p.tokens != 1 || p.sends != 1 {
		t.Fatalf("rejected token: %+v %v %d/%d", result, err, p.tokens, p.sends)
	}
	result, err = c.Send(context.Background(), mediaInput())
	if err != nil || result.Status != model.Sent || p.tokens != 2 || p.sends != 2 {
		t.Fatalf("renewal: %+v %v %d/%d", result, err, p.tokens, p.sends)
	}
}
