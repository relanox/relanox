package wechat

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// SendMessage's SDK method ignores business ret/errcode. The parser unit test
// cannot detect an omitted adapter turning rejection into Sent; exercise Send
// through actual HTTP with no new production seam. The -14 fixture follows
// https://github.com/Tencent/openclaw-weixin/blob/main/src/monitor/monitor.ts.
func TestSDKSendPreservesNativeRejections(t *testing.T) {
	for _, fixture := range []struct {
		name, body, code string
		status           int
		want             model.Outcome
	}{
		{"accepted", `{"ret":0}`, "", 200, model.Sent},
		{"expired", `{"ret":-14}`, "wechat_session_expired", 200, model.Rejected},
		{"expired-with-generic-error", `{"ret":-1,"errcode":-14}`, "wechat_session_expired", 200, model.Rejected},
		{"rejected", `{"ret":1}`, "wechat_send_rejected", 200, model.Rejected},
		{"http-failure", `{"ret":0}`, "wechat_send_unknown", 500, model.Unknown},
		{"rate-limit", `{"ret":0}`, "wechat_rate_limited", 429, model.Retryable},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/ilink/bot/sendmessage" || r.Header.Get("Authorization") != "Bearer public-token" {
					t.Error("native request scope")
				}
				w.WriteHeader(fixture.status)
				writePeerResponse(t, w, fixture.body)
			}))
			defer peer.Close()
			cfg := Config{BotID: "bot", BotToken: model.SecretRef{Env: "PUBLIC_FIXTURE"}, APIBaseURL: peer.URL, CDNBaseURL: peer.URL + "/c2c", AllowInsecureLoopback: true}
			channel, err := New(nil, model.AccountConfig{ID: "wechat", Channel: model.WeChat, Config: common.Data(cfg)}, common.Options{HTTPClient: peer.Client(), ResolveSecret: func(model.SecretRef) (string, error) { return "public-token", nil }})
			if err != nil {
				t.Fatal(err)
			}
			target := model.ReplyTarget{Channel: model.WeChat, AccountID: "wechat", ChatID: "alice", Data: common.Data(targetData{BotID: "bot", APIBaseURL: peer.URL, ContextToken: "public-context"})}
			result, err := channel.Send(context.Background(), model.SendInput{Target: target, Chunk: model.DeliveryChunk{Text: "hello", IdempotencyKey: "public-message"}})
			if err != nil || result.Status != fixture.want || result.ErrorCode != fixture.code {
				t.Fatalf("send: %+v %v", result, err)
			}
		})
	}
}

// writePeerResponse fails the fixture when its native response cannot be delivered.
func writePeerResponse(t *testing.T, w http.ResponseWriter, body string) {
	t.Helper()
	if _, err := io.WriteString(w, body); err != nil {
		t.Error(err)
	}
}
