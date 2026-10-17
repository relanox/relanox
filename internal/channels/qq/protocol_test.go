package qq

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/internal/channeltest"
	"github.com/relanox/relanox/internal/model"
)

type testHost struct{ model.ChannelHost }

func (testHost) MaxMediaBytes() int64                      { return 100 * 1024 * 1024 }
func (testHost) Observer() model.Observer                  { return nil }
func (testHost) Connection(model.ConnectionStatus, string) {}
func (testHost) Media() model.ChannelMediaHost             { return nil }
func (testHost) PublicURL() string                         { return "" }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func redirectedClient(t *testing.T, handler http.Handler) *http.Client {
	t.Helper()
	peer := httptest.NewServer(handler)
	t.Cleanup(peer.Close)
	base, _ := url.Parse(peer.URL)
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme = base.Scheme
		copy.URL.Host = base.Host
		return http.DefaultTransport.RoundTrip(copy)
	})}
}

func testChannel(t *testing.T, client *http.Client) (*Channel, *string) {
	t.Helper()
	secret := "public-first"
	c, err := New(testHost{}, model.AccountConfig{ID: "account", Channel: model.QQ, Config: common.Data(Config{AppID: "app", ClientSecret: model.SecretRef{Env: "SECRET"}, RecipientTypes: map[string]string{"user": "c2c", "group": "group"}})}, common.Options{HTTPClient: client, ResolveSecret: func(model.SecretRef) (string, error) { return secret, nil }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	return c, &secret
}

func sendInput(c *Channel, kind string) model.SendInput {
	at := time.Now().UnixMilli()
	data := targetData{Type: kind, MessageID: "native-message", MessageIndex: "native-index", MessageAt: &at, Scope: c.identity()}
	return model.SendInput{Reply: &model.ReplyReference{RequestID: "request", Kind: model.Final}, Target: model.ReplyTarget{Channel: model.QQ, AccountID: "account", ChatID: "recipient/with space", ReplyToID: "native-message", Data: common.Data(data)}, Chunk: model.DeliveryChunk{Text: "**answer**", IdempotencyKey: "chunk"}}
}

type messagePeer struct {
	t             *testing.T
	tokens, sends int
	status        int
	body          string
	secret        string
	requests      []nativeSend
	paths         []string
}

func (p *messagePeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/app/getAppAccessToken" {
		p.tokens++
		var body struct {
			AppID  string `json:"appId"`
			Secret string `json:"clientSecret"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.AppID != "app" {
			p.t.Error("native OAuth fields lost")
		}
		p.secret = body.Secret
		channeltest.WriteResponse(p.t, w, fmt.Sprintf(`{"access_token":%q,"expires_in":"7200"}`, "token-"+body.Secret))
		return
	}
	p.sends++
	var body nativeSend
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		p.t.Error(err)
	}
	if r.Header.Get("Authorization") != "QQBot token-"+p.secret {
		p.t.Error("native authorization scheme changed")
	}
	p.requests = append(p.requests, body)
	p.paths = append(p.paths, r.URL.EscapedPath())
	if p.status != 0 {
		w.WriteHeader(p.status)
	}
	if p.body != "" {
		channeltest.WriteResponse(p.t, w, p.body)
	} else {
		channeltest.WriteResponse(p.t, w, `{"id":"native-sent"}`)
	}
}

// Protects native recipient paths, passive/explicit-quote distinctions, dynamic
// credentials and unknown outcomes through real HTTP. Generic transport and
// splitting tests do not cover QQ envelopes. No core behavior or seam is mocked.
func TestNativeSendIdentityWindowAndRotatingToken(t *testing.T) {
	// Verified SDK: @tencent-connect/qqbot-nodejs 1.0.5 QQBot.send,
	// protocol/api/{messages,routes,token}.ts and protocol/types.ts.
	// https://github.com/tencent-connect/qqbot-nodejs
	p := &messagePeer{t: t}
	c, secret := testChannel(t, redirectedClient(t, p))
	input := sendInput(c, "c2c")
	result, err := c.Send(context.Background(), input)
	if err != nil || result.Status != model.Sent {
		t.Fatalf("send: %+v %v", result, err)
	}
	assertMessage(t, p.requests[0], true, true)
	input.Reply = nil
	result, err = c.Send(context.Background(), input)
	if err != nil || result.Status != model.Sent {
		t.Fatal("ordinary send failed")
	}
	assertMessage(t, p.requests[1], true, false)
	*secret = "public-rotated"
	expired := time.Now().Add(-2 * time.Hour).UnixMilli()
	var target targetData
	if err := json.Unmarshal(input.Target.Data, &target); err != nil {
		t.Error(err)
	}
	target.MessageAt = &expired
	input.Target.Data = common.Data(target)
	result, err = c.Send(context.Background(), input)
	if err != nil || result.Status != model.Sent {
		t.Fatal("proactive send failed")
	}
	assertMessage(t, p.requests[2], false, false)
	if p.tokens != 2 || p.paths[0] != "/v2/users/recipient%2Fwith%20space/messages" {
		t.Fatalf("token/path: %d %v", p.tokens, p.paths)
	}
}

func assertMessage(t *testing.T, body nativeSend, passive, quoted bool) {
	t.Helper()
	if body.Type != 2 || body.Markdown == nil || body.Markdown.Content != "**answer**" {
		t.Fatalf("native Markdown: %+v", body)
	}
	if passive && body.MessageID != "native-message" {
		t.Fatal("passive association lost")
	}
	if !passive && (body.MessageID != "" || body.Sequence != 1) {
		t.Fatal("expired passive association retained")
	}
	if quoted {
		if body.Reference == nil || body.Reference.MessageID != "native-index" {
			t.Fatal("quoted native msg_idx was replaced by msg_id")
		}
	} else if body.Reference != nil {
		t.Fatal("ordinary send unexpectedly quoted a message")
	}
}

func TestNativeBusinessErrorsDoNotReplayUncertainSends(t *testing.T) {
	p := &messagePeer{t: t}
	c, _ := testChannel(t, redirectedClient(t, p))
	for _, fixture := range []struct {
		status int
		body   string
		want   model.Outcome
		code   string
	}{
		{200, `{"code":40054005}`, model.Unknown, "qq_duplicate_effect"},
		{200, `{"code":50055001}`, model.Retryable, "qq_50055001"},
		{403, `{"code":40034025}`, model.Rejected, "qq_40034025"},
		{503, `{}`, model.Unknown, "native_send_uncertain"},
	} {
		p.status = fixture.status
		p.body = fixture.body
		before := p.sends
		result, err := c.Send(context.Background(), sendInput(c, "group"))
		if err != nil || result.Status != fixture.want || result.ErrorCode != fixture.code || p.sends != before+1 {
			t.Fatalf("native result/replay: %+v %v %d", result, err, p.sends-before)
		}
	}
}

func TestNativeMediaFormatsAndSILKReceiveMetadata(t *testing.T) {
	c, _ := testChannel(t, redirectedClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("invalid media contacted native API")
		w.WriteHeader(500)
	})))
	input := sendInput(c, "c2c")
	ref := model.MediaReference{ID: "media", Kind: model.Audio, MIMEType: "audio/mpeg", FileName: "voice.mp3"}
	input.Chunk.Media = &ref
	input.Media = &model.StoredMedia{Reference: ref, Data: []byte("mp3")}
	result, err := c.Send(context.Background(), input)
	if err != nil || result.Status != model.Rejected || result.ErrorCode != "unsupported_media_format" {
		t.Fatalf("format: %+v %v", result, err)
	}
	if mime := attachmentMIME("audio/amr", "audio/amr", "voice.amr", []byte("\x02#!SILK_V3")); mime != "audio/silk" {
		t.Fatalf("native codec lost: %s", mime)
	}
	if mime := attachmentMIME("voice", "application/octet-stream", "voice.amr", nil); mime != "audio/amr" {
		t.Fatalf("native voice label used as MIME: %s", mime)
	}
}

func TestTokenFailureBeforeMessageTransmitRemainsRetryable(t *testing.T) {
	c, _ := testChannel(t, redirectedClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("failed credential resolution contacted network")
		w.WriteHeader(500)
	})))
	c.options.ResolveSecret = func(model.SecretRef) (string, error) { return "", errors.New("missing_secret") }
	result, err := c.Send(context.Background(), sendInput(c, "c2c"))
	if err != nil || result.Status != model.Retryable {
		t.Fatalf("pre-transmission failure became unknown: %+v %v", result, err)
	}
}
