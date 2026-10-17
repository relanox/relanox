package speech_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/speech"
)

// Actual Tencent SDK requests go over TLS to an external-only protocol peer.
// Fixtures follow the official SDK and API (nullable word details are native):
// https://cloud.tencent.com/document/api/1093/35646
// https://github.com/TencentCloud/tencentcloud-sdk-go/blob/master/tencentcloud/asr/v20190614/models.go
// These protect captured options, rotating secret references, native request
// fields and cancellation/fallback. Existing core tests disable preparation;
// they cannot detect these provider regressions. HTTPClient is a production
// trust/transport option and ReadMedia is the core's existing scoped capability.
type asrRequest struct {
	Body struct {
		Engine string `json:"EngSerViceType"`
		Source int    `json:"SourceType"`
		Format string `json:"VoiceFormat"`
		Data   string `json:"Data"`
		Length int    `json:"DataLen"`
	}
	Header http.Header
	Host   string
}

type asrPeer struct {
	server    *httptest.Server
	requests  chan asrRequest
	cancelled chan struct{}
}

func newASRPeer(t *testing.T, response string, hold bool) *asrPeer {
	t.Helper()
	p := &asrPeer{requests: make(chan asrRequest, 16), cancelled: make(chan struct{}, 16)}
	p.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request asrRequest
		if err := json.NewDecoder(r.Body).Decode(&request.Body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		request.Header, request.Host = r.Header.Clone(), r.Host
		p.requests <- request
		if hold {
			<-r.Context().Done()
			p.cancelled <- struct{}{}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(p.server.Close)
	return p
}

type peerTransport struct {
	base   http.RoundTripper
	target *url.URL
}

func (p peerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	u := *r.URL
	r.Host = u.Host
	u.Scheme, u.Host = p.target.Scheme, p.target.Host
	r.URL = &u
	return p.base.RoundTrip(r)
}

func (p *asrPeer) client() *http.Client {
	client := *p.server.Client()
	target, _ := url.Parse(p.server.URL)
	client.Transport = peerTransport{base: client.Transport, target: target}
	return &client
}

func speechConfig() config.Speech {
	return config.Speech{Enabled: true, Region: "ap-shanghai", EngineModelType: "16k_en", SecretID: model.SecretRef{Env: "OLD_ASR_ID"}, SecretKey: model.SecretRef{Env: "OLD_ASR_KEY"}}
}

func speechInput(t *testing.T, preparer *speech.Preparer, media []model.StoredMedia) model.PreparationInput {
	t.Helper()
	input := model.PreparationInput{Message: model.AgentMessage{Text: "original voice message"}, ReadMedia: func(_ context.Context, id string) (*model.StoredMedia, error) {
		for _, asset := range media {
			if asset.Reference.ID == id {
				return &asset, nil
			}
		}
		return nil, nil
	}}
	for _, asset := range media {
		input.Message.Attachments = append(input.Message.Attachments, asset.Reference)
	}
	plan, err := preparer.Plan(input.Message)
	if err != nil || plan == nil {
		t.Fatalf("plan: %#v %v", plan, err)
	}
	input.Options = plan.Options
	return input
}

func TestNativeRecognitionUsesCapturedOptionsAndRotatingReferences(t *testing.T) {
	peer := newASRPeer(t, `{"Response":{"Result":"captured transcript","AudioDuration":2430,"WordSize":null,"WordList":null,"RequestId":"41ed9283-0c09-46fb-917b-0b83fa95f0be"}}`, false)
	t.Setenv("OLD_ASR_ID", "old-id")
	t.Setenv("OLD_ASR_KEY", "old-key")
	options := speech.Options{HTTPClient: peer.client(), ResolveSecret: (config.Config{}).ResolveSecret}
	preparer, err := speech.New(speechConfig(), options)
	if err != nil {
		t.Fatal(err)
	}
	input := speechInput(t, preparer, []model.StoredMedia{{Reference: model.MediaReference{ID: "audio-A", Kind: model.Audio, MIMEType: "audio/wav", Size: 3}, Data: []byte("abc")}})
	if strings.Contains(string(input.Options), "old-key") || strings.Contains(string(input.Options), "old-id") || !strings.Contains(string(input.Options), "OLD_ASR_KEY") {
		t.Fatalf("unsafe or missing captured credential reference: %s", input.Options)
	}
	t.Setenv("OLD_ASR_ID", "rotated-id")
	t.Setenv("OLD_ASR_KEY", "rotated-key")
	changed := speechConfig()
	changed.EngineModelType, changed.Region = "8k_zh", "ap-guangzhou"
	changed.SecretID, changed.SecretKey = model.SecretRef{Env: "NEW_ASR_ID"}, model.SecretRef{Env: "NEW_ASR_KEY"}
	preparer, err = speech.New(changed, options)
	if err != nil {
		t.Fatal(err)
	}
	output, err := preparer.Process(context.Background(), input)
	if err != nil || output.Text != "original voice message\n\n[Voice transcript: audio-A]\ncaptured transcript" {
		t.Fatalf("recognition: %#v %v", output, err)
	}
	request := <-peer.requests
	if request.Body.Engine != "16k_en" || request.Header.Get("X-TC-Region") != "ap-shanghai" || request.Body.Source != 1 || request.Body.Format != "wav" || request.Body.Data != "YWJj" || request.Body.Length != 3 || request.Host != "asr.tencentcloudapi.com" || !strings.HasPrefix(request.Header.Get("Authorization"), "TC3-HMAC-SHA256 Credential=rotated-id/") || request.Header.Get("X-TC-Action") != "SentenceRecognition" {
		t.Fatalf("native captured request changed: %#v", request)
	}
}

func TestRecognitionFallsBackPerClipWithoutLeakingProviderErrors(t *testing.T) {
	peer := newASRPeer(t, `{"Response":{"Error":{"Code":"AuthFailure.SignatureFailure","Message":"private provider diagnostic credential=do-not-leak"},"RequestId":"41ed9283-0c09-46fb-917b-0b83fa95f0be"}}`, false)
	preparer, err := speech.New(speechConfig(), speech.Options{HTTPClient: peer.client(), ResolveSecret: func(model.SecretRef) (string, error) { return "fixture", nil }})
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(60_001)
	media := []model.StoredMedia{
		{Reference: model.MediaReference{ID: "vorbis", Kind: model.Audio, MIMEType: "audio/ogg"}, Data: []byte("OggS-Vorbis")},
		{Reference: model.MediaReference{ID: "large", Kind: model.Audio, MIMEType: "audio/wav"}, Data: make([]byte, 2_250_001)},
		{Reference: model.MediaReference{ID: "long", Kind: model.Audio, MIMEType: "audio/wav", DurationMS: &duration}, Data: []byte("abc")},
		{Reference: model.MediaReference{ID: "native-error", Kind: model.Audio, MIMEType: "audio/ogg"}, Data: []byte("OggS----OpusHead")},
	}
	input := speechInput(t, preparer, media)
	output, err := preparer.Process(context.Background(), input)
	var data struct {
		Transcriptions []speech.Transcription `json:"transcriptions"`
	}
	if err != nil || json.Unmarshal(output.Data, &data) != nil || output.Text != input.Message.Text || len(data.Transcriptions) != 4 || strings.Contains(string(output.Data), "do-not-leak") {
		t.Fatalf("fallback: %#v %v", output, err)
	}
	for i, code := range []string{"unsupported_format", "audio_too_large", "audio_too_long", "recognition_failed"} {
		if data.Transcriptions[i].ErrorCode != code || data.Transcriptions[i].MediaID != media[i].Reference.ID {
			t.Fatalf("per-clip fallback order: %#v", data.Transcriptions)
		}
	}
	if len(peer.requests) != 1 {
		t.Fatalf("invalid clips reached native API: %d", len(peer.requests))
	}
}

func TestRecognitionCancellationClosesRealHTTPRequest(t *testing.T) {
	peer := newASRPeer(t, "", true)
	preparer, err := speech.New(speechConfig(), speech.Options{HTTPClient: peer.client(), ResolveSecret: func(model.SecretRef) (string, error) { return "fixture", nil }})
	if err != nil {
		t.Fatal(err)
	}
	input := speechInput(t, preparer, []model.StoredMedia{{Reference: model.MediaReference{ID: "audio", Kind: model.Audio, MIMEType: "audio/wav"}, Data: []byte("abc")}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan model.PreparationOutput, 1)
	go func() { output, _ := preparer.Process(ctx, input); done <- output }()
	select {
	case <-peer.requests:
	case <-time.After(2 * time.Second):
		t.Fatal("native request not started")
	}
	cancel()
	select {
	case output := <-done:
		if output.Text != input.Message.Text || !strings.Contains(string(output.Data), `"errorCode":"timeout"`) {
			t.Fatalf("cancel fallback: %#v", output)
		}
	case <-time.After(time.Second):
		t.Fatal("speech did not stop")
	}
	select {
	case <-peer.cancelled:
	case <-time.After(time.Second):
		t.Fatal("context cancellation did not reach native HTTP")
	}
}

// An oversized response can begin with valid JSON and whitespace. A silently
// truncating reader would accept its transcript, unlike the actual size bound.
func TestRecognitionRejectsOversizedResponseWithValidJSONPrefix(t *testing.T) {
	peer := newASRPeer(t, `{"Response":{"Result":"oversized transcript"}}`+strings.Repeat(" ", 1<<20), false)
	preparer, err := speech.New(speechConfig(), speech.Options{HTTPClient: peer.client(), ResolveSecret: func(model.SecretRef) (string, error) { return "fixture", nil }})
	if err != nil {
		t.Fatal(err)
	}
	input := speechInput(t, preparer, []model.StoredMedia{{Reference: model.MediaReference{ID: "audio", Kind: model.Audio, MIMEType: "audio/wav"}, Data: []byte("abc")}})
	output, err := preparer.Process(context.Background(), input)
	if err != nil || output.Text != input.Message.Text || strings.Contains(string(output.Data), "oversized transcript") || !strings.Contains(string(output.Data), `"status":"failed"`) {
		t.Fatalf("oversized response accepted: %#v %v", output, err)
	}
}
