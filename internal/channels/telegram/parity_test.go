package telegram

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// Telegram animation objects may contain MPEG-4 video; audio accepts MP3 and
// M4A. The voice fixture misses these native media variants. Actual webhook,
// download and multipart HTTP requests use the existing host and SDK seams.
// https://core.telegram.org/bots/api#animation
// https://core.telegram.org/bots/api#sendaudio
func TestAnimationAndAudioVariants(t *testing.T) {
	host := &protocolHost{}
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/bot123:public/getFile":
			_, _ = io.WriteString(w, `{"ok":true,"result":{"file_path":"animation/file.mp4","file_size":3}}`)
		case "/file/bot123:public/animation/file.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = io.WriteString(w, "vid")
		case "/bot123:public/sendAudio":
			if err := r.ParseMultipartForm(1024); err != nil {
				t.Error(err)
				return
			}
			defer func() { _ = r.MultipartForm.RemoveAll() }()
			file, _, err := r.FormFile("audio")
			if err != nil {
				t.Error(err)
				return
			}
			defer func() { _ = file.Close() }()
			data, _ := io.ReadAll(file)
			if string(data) != "mp3" {
				t.Error("native audio bytes changed")
			}
			_, _ = io.WriteString(w, `{"ok":true,"result":{"message_id":1234}}`)
		default:
			t.Errorf("unexpected media method: %s", r.URL.Path)
			w.WriteHeader(400)
		}
	}))
	defer peer.Close()
	c, err := New(host, model.AccountConfig{ID: "tg", Channel: model.Telegram, AllowedSenders: []string{"1"}, Config: common.Data(Config{BotToken: model.SecretRef{Env: "TOKEN"}, WebhookSecret: model.SecretRef{Env: "WEBHOOK"}, APIBaseURL: peer.URL, AllowInsecureLoopback: true})}, common.Options{HTTPClient: peer.Client(), ResolveSecret: func(model.SecretRef) (string, error) { return "123:public", nil }})
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		mime     string
		kind     model.MediaKind
		fallback string
	}{{"video/mp4", model.Video, "video/mp4"}, {"image/gif", model.Image, "image/gif"}, {"", model.Video, "video/mp4"}} {
		t.Run("animation-"+fixture.mime, func(t *testing.T) {
			body := fmt.Sprintf(`{"update_id":1,"message":{"message_id":77,"from":{"id":1,"is_bot":false},"chat":{"id":-100123,"type":"supergroup"},"animation":{"file_id":"animation","file_size":3,"mime_type":%q}}}`, fixture.mime)
			req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
			req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "123:public")
			response := httptest.NewRecorder()
			before := len(host.received)
			host.handler.ServeHTTP(response, req)
			if response.Code != 200 || len(host.received) != before+1 {
				t.Fatalf("native animation was not ingested: %d", response.Code)
			}
			media := host.received[before].Attachments
			if len(media) != 1 || media[0].Kind != fixture.kind || media[0].MIMEType != fixture.fallback || string(media[0].Data) != "vid" {
				t.Fatalf("native animation: %+v", media)
			}
		})
	}
	resolved, err := c.Resolve(t.Context(), model.ChannelAddress{Platform: model.Telegram, AccountID: "tg", ChatID: "4"}, nil)
	if err != nil || resolved.Target == nil {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	for _, mime := range []string{"audio/mp3", "audio/x-mp3", "audio/m4a"} {
		t.Run(mime, func(t *testing.T) {
			media := model.StoredMedia{Reference: model.MediaReference{ID: "audio", Kind: model.Audio, MIMEType: mime, FileName: "audio.mp3", Size: 3}, Data: []byte("mp3")}
			result, err := c.Send(t.Context(), model.SendInput{Target: *resolved.Target, Chunk: model.DeliveryChunk{Media: &media.Reference}, Media: &media})
			if err != nil || result.Status != model.Sent {
				t.Fatalf("native audio: %+v %v", result, err)
			}
		})
	}
}
