package feishu

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

type outboundHost struct{ model.ChannelHost }

func (outboundHost) MountHTTP(model.HTTPRoute) error { return nil }
func (outboundHost) MaxMediaBytes() int64            { return 100 * 1024 * 1024 }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Protects SDK-to-wire boundaries: the native token is top-level, selected replies
// use a message ID, and ordinary thread sends use its real root. A wrong envelope
// or thread target breaks real HTTP traffic. No core/persistence is simulated.
func TestNativeTokenAndSelectedThreadReply(t *testing.T) {
	// Source: larksuite/oapi-sdk-go v3.12.2 core/tokenmanager.go and
	// service/im/v1/model.go, plus documented native reply endpoint:
	// https://open.feishu.cn/document/server-docs/im-v1/message/reply
	var paths []string
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/open-apis/auth/v3/tenant_access_token/internal":
			writePeerResponse(t, w, `{"code":0,"tenant_access_token":"public-token","expire":7200}`)
		case "/open-apis/bot/v3/info":
			writePeerResponse(t, w, `{"code":0,"bot":{"open_id":"ou_bot"}}`)
		default:
			paths = append(paths, r.URL.RequestURI())
			if r.Header.Get("Authorization") != "Bearer public-token" {
				t.Error("native token missing")
			}
			var body struct {
				Type     string `json:"msg_type"`
				Content  string `json:"content"`
				InThread bool   `json:"reply_in_thread"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body.Type != "post" {
				t.Errorf("Markdown changed native type: %+v", body)
			}
			var post struct {
				ZH struct {
					Rows [][]struct {
						Tag  string `json:"tag"`
						Text string `json:"text"`
					} `json:"content"`
				} `json:"zh_cn"`
			}
			if err := json.Unmarshal([]byte(body.Content), &post); err != nil || len(post.ZH.Rows) != 1 || post.ZH.Rows[0][0].Tag != "md" {
				t.Error("native Markdown post missing")
			}
			writePeerResponse(t, w, `{"code":0,"data":{"message_id":"om_sent"}}`)
		}
	}))
	defer peer.Close()
	base, _ := url.Parse(peer.URL)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme = base.Scheme
		copy.URL.Host = base.Host
		return http.DefaultTransport.RoundTrip(copy)
	})}
	cfg := Config{AppID: "app", TenantKey: "tenant", AppSecret: model.SecretRef{Env: "SECRET"}, VerificationToken: model.SecretRef{Env: "VERIFY"}, EncryptKey: model.SecretRef{Env: "ENCRYPT"}}
	c, err := New(outboundHost{}, model.AccountConfig{ID: "account", Channel: model.Feishu, Config: common.Data(cfg)}, common.Options{HTTPClient: client, ResolveSecret: func(model.SecretRef) (string, error) { return "public-secret", nil }})
	if err != nil {
		t.Fatal(err)
	}
	target := model.ReplyTarget{Channel: model.Feishu, AccountID: "account", ChatID: "oc_chat", ThreadID: "omt_thread", ReplyToID: "om_selected", Data: common.Data(targetData{AppID: "app", TenantKey: "tenant", BotID: "ou_bot", APIBaseURL: "https://open.feishu.cn", ThreadAnchor: "om_root"})}
	input := model.SendInput{Target: target, Chunk: model.DeliveryChunk{Text: "**answer**", IdempotencyKey: "answer"}, Reply: &model.ReplyReference{RequestID: "request", Kind: model.Final}}
	result, err := c.Send(context.Background(), input)
	if err != nil || result.Status != model.Sent {
		t.Fatalf("selected reply: %+v %v", result, err)
	}
	input.Reply = nil
	if result, err = c.Send(context.Background(), input); err != nil || result.Status != model.Sent {
		t.Fatalf("ordinary thread send: %+v %v", result, err)
	}
	input.Target.ThreadID = ""
	if result, err = c.Send(context.Background(), input); err != nil || result.Status != model.Sent {
		t.Fatalf("ordinary send: %+v %v", result, err)
	}
	if len(paths) != 3 || paths[0] != "/open-apis/im/v1/messages/om_selected/reply" || paths[1] != "/open-apis/im/v1/messages/om_root/reply" || paths[2] != "/open-apis/im/v1/messages?receive_id_type=chat_id" {
		t.Fatalf("native routes: %v", paths)
	}
}

func TestNativePostNormalizationFormsAndMentions(t *testing.T) {
	// Official native content supports direct and localized post bodies, md and
	// labeled link nodes. The official Node SDK resolves mention keys in supplied
	// order; this fixture intentionally preserves that existing contract.
	// https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content
	for _, content := range []string{`{"title":"Question","content":[[{"tag":"text","text":"Analyze "},{"tag":"a","text":"the report","href":"https://example.com/report"}]]}`, `{"zh_cn":{"title":"Question","content":[[{"tag":"text","text":"Analyze "},{"tag":"a","text":"the report","href":"https://example.com/report"}]]}}`} {
		actual, resources, err := normalizeContent(nativeMessage{Type: "post", Content: content}, "ou_bot")
		if err != nil || actual != "**Question**\n\nAnalyze [the report](https://example.com/report)" || len(resources) != 0 {
			t.Fatalf("post: %q %+v %v", actual, resources, err)
		}
	}
	message := nativeMessage{Type: "text", Content: `{"text":"@_user_1 asks @_user_10"}`}
	var mentions []*mention
	if err := json.Unmarshal([]byte(`[{"key":"@_user_1","name":"Alice","id":{"open_id":"ou_alice"}},{"key":"@_user_10","name":"Bob","id":{"open_id":"ou_bob"}}]`), &mentions); err != nil {
		t.Fatal(err)
	}
	message.Mentions = mentions
	actual, _, err := normalizeContent(message, "ou_bot")
	if err != nil || actual != "@Alice asks @Alice0" {
		t.Fatalf("native mention order: %q %v", actual, err)
	}
}

// writePeerResponse fails the fixture when its native response cannot be delivered.
func writePeerResponse(t *testing.T, w http.ResponseWriter, body string) {
	t.Helper()
	if _, err := io.WriteString(w, body); err != nil {
		t.Error(err)
	}
}
