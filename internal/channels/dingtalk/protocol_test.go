package dingtalk

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/internal/channeltest"
	"github.com/relanox/relanox/internal/model"
)

type outboundHost struct{ model.ChannelHost }

func (outboundHost) MaxMediaBytes() int64 { return 100 * 1024 * 1024 }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type nativePeer struct {
	t        *testing.T
	response string
	sends    []nativeSend
	uploads  []string
}

type nativeSend struct {
	Path           string
	RobotCode      string   `json:"robotCode"`
	UserIDs        []string `json:"userIds"`
	ConversationID string   `json:"openConversationId"`
	Key            string   `json:"msgKey"`
	Parameters     string   `json:"msgParam"`
}

func (p *nativePeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/v1.0/oauth2/accessToken":
		var credentials struct {
			AppKey    string `json:"appKey"`
			AppSecret string `json:"appSecret"`
		}
		if json.NewDecoder(r.Body).Decode(&credentials) != nil || credentials.AppKey != "app" || credentials.AppSecret != "public-secret" {
			p.t.Error("wrong SDK OAuth envelope")
		}
		channeltest.WriteResponse(p.t, w, `{"accessToken":"native-token","expireIn":7200}`)
	case "/media/upload":
		if r.URL.Query().Get("access_token") != "native-token" {
			p.t.Error("missing upload token")
		}
		if err := r.ParseMultipartForm(1024); err != nil {
			p.t.Error(err)
			return
		}
		defer func() { _ = r.MultipartForm.RemoveAll() }()
		if len(r.MultipartForm.File["media"]) != 1 {
			p.t.Error("native media field missing")
		}
		p.uploads = append(p.uploads, r.URL.Query().Get("type"))
		channeltest.WriteResponse(p.t, w, fmt.Sprintf(`{"errcode":0,"media_id":%q}`, fmt.Sprintf("@native-%d", len(p.uploads))))
	default:
		if r.Header.Get("x-acs-dingtalk-access-token") != "native-token" {
			p.t.Error("missing robot token")
		}
		var body nativeSend
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			p.t.Error(err)
			return
		}
		body.Path = r.URL.Path
		p.sends = append(p.sends, body)
		channeltest.WriteResponse(p.t, w, p.response)
	}
}

func nativeFixture(t *testing.T) (*Channel, *nativePeer) {
	t.Helper()
	p := &nativePeer{t: t, response: `{"processQueryKey":"process"}`}
	server := httptest.NewServer(p)
	t.Cleanup(server.Close)
	base, _ := url.Parse(server.URL)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme = base.Scheme
		copy.URL.Host = base.Host
		return http.DefaultTransport.RoundTrip(copy)
	})}
	c, err := New(outboundHost{}, model.AccountConfig{ID: "account", Channel: model.DingTalk, Config: common.Data(Config{ClientID: "app", RobotCode: "robot", ClientSecret: model.SecretRef{Env: "SECRET"}, RecipientTypes: map[string]string{"staff": "single", "group": "group"}})}, common.Options{HTTPClient: client, ResolveSecret: func(model.SecretRef) (string, error) { return "public-secret", nil }})
	if err != nil {
		t.Fatal(err)
	}
	return c, p
}

func nativeInput(c *Channel, group bool) model.SendInput {
	target := targetData{Type: "single", StaffID: "staff", Scope: c.identity()}
	chatID := "staff"
	if group {
		target = targetData{Type: "group", OpenConversationID: "group", Scope: c.identity()}
		chatID = "group"
	}
	return model.SendInput{Target: model.ReplyTarget{Channel: model.DingTalk, AccountID: "account", ChatID: chatID, Data: common.Data(target)}, Chunk: model.DeliveryChunk{IdempotencyKey: "send", Text: "**native**"}}
}

// Protects SDK envelope/recipient/result contracts through actual HTTP traffic.
// Wrong generated JSON field names, recipient selection or a missing receipt can
// silently lose output. Existing socket/transport tests do not cover robot calls.
// No production seam or mock routing/storage is used.
func TestNativeRobotEnvelopesAndDefiniteOutcomes(t *testing.T) {
	// Verified generated types: alibabacloud-go/dingtalk v1.7.46 robot_1_0/client.go
	// https://open.dingtalk.com/document/isvapp/robot-send-personal-chat-messages
	// https://open.dingtalk.com/document/group-chat-session/robot-send-group-chat-messages
	c, p := nativeFixture(t)
	for _, group := range []bool{false, true} {
		result, err := c.Send(context.Background(), nativeInput(c, group))
		if err != nil || result.Status != model.Sent {
			t.Fatalf("native send: %+v %v", result, err)
		}
	}
	if len(p.sends) != 2 {
		t.Fatalf("sends: %d", len(p.sends))
	}
	assertNativeRecipient(t, p.sends[0], false)
	assertNativeRecipient(t, p.sends[1], true)
	for _, fixture := range []struct {
		body string
		want model.Outcome
		code string
	}{
		{`{"invalidStaffIdList":["staff"]}`, model.Rejected, "invalid_staff_id"},
		{`{"flowControlledStaffIdList":["staff"]}`, model.Retryable, "staff_rate_limited"},
		{`{}`, model.Unknown, "missing_message_receipt"},
	} {
		p.response = fixture.body
		result, err := c.Send(context.Background(), nativeInput(c, false))
		if err != nil || result.Status != fixture.want || result.ErrorCode != fixture.code {
			t.Fatalf("result: %+v %v", result, err)
		}
	}
}

func assertNativeRecipient(t *testing.T, body nativeSend, group bool) {
	t.Helper()
	if body.RobotCode != "robot" || body.Key != "sampleMarkdown" {
		t.Fatalf("native envelope: %+v", body)
	}
	if group {
		if body.Path != "/v1.0/robot/groupMessages/send" || body.ConversationID != "group" || len(body.UserIDs) != 0 {
			t.Fatalf("group: %+v", body)
		}
	} else if body.Path != "/v1.0/robot/oToMessages/batchSend" || len(body.UserIDs) != 1 || body.UserIDs[0] != "staff" || body.ConversationID != "" {
		t.Fatalf("single: %+v", body)
	}
	var parameters map[string]string
	if json.Unmarshal([]byte(body.Parameters), &parameters) != nil || parameters["text"] != "**native**" {
		t.Fatalf("native msgParam: %s", body.Parameters)
	}
}

func TestNativeAudioVideoAndFileParameters(t *testing.T) {
	// Native template keys and parameters are documented by the same SDK's
	// robot_1_0, with media IDs from /media/upload. Duration is ms for audio and
	// seconds for sampleVideo; video uses a distinct uploaded preview.
	c, p := nativeFixture(t)
	duration := int64(1500)
	for _, fixture := range []struct {
		kind      model.MediaKind
		mime, key string
		want      map[string]string
	}{
		{model.Image, "image/png", "sampleImageMsg", map[string]string{"photoURL": "@native-1"}},
		{model.Audio, "audio/amr", "sampleAudio", map[string]string{"mediaId": "@native-2", "duration": "1500"}},
		{model.Video, "video/mp4", "sampleVideo", map[string]string{"videoMediaId": "@native-3", "picMediaId": "@native-4", "duration": "2", "videoType": "mp4"}},
		{model.File, "application/pdf", "sampleFile", map[string]string{"mediaId": "@native-5", "fileName": "report.pdf", "fileType": "pdf"}},
	} {
		input := nativeInput(c, false)
		input.Chunk.Text = ""
		ref := model.MediaReference{ID: "media", Kind: fixture.kind, MIMEType: fixture.mime, FileName: "report.pdf", DurationMS: &duration, Size: 3}
		input.Chunk.Media = &ref
		input.Media = &model.StoredMedia{Reference: ref, Data: []byte("raw")}
		input.Preview = &model.StoredMedia{Reference: model.MediaReference{Kind: model.Image, FileName: "preview.png"}, Data: []byte("png")}
		result, err := c.Send(context.Background(), input)
		if err != nil || result.Status != model.Sent {
			t.Fatalf("media: %+v %v", result, err)
		}
		body := p.sends[len(p.sends)-1]
		var parameters map[string]string
		if body.Key != fixture.key || json.Unmarshal([]byte(body.Parameters), &parameters) != nil {
			t.Fatalf("media envelope: %+v", body)
		}
		for key, value := range fixture.want {
			if parameters[key] != value {
				t.Fatalf("%s: %s=%q, want %q", fixture.kind, key, parameters[key], value)
			}
		}
	}
	if fmt.Sprint(p.uploads) != "[image voice video image file]" {
		t.Fatalf("native media types: %v", p.uploads)
	}
}
