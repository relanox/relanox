package qq

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/model"
)

type smallPeer struct {
	t        *testing.T
	types    []int
	messages int
}

func (p *smallPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/app/getAppAccessToken" {
		fmt.Fprint(w, `{"access_token":"native","expires_in":7200}`)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/files") {
		p.upload(w, r)
		return
	}
	var body nativeSend
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		p.t.Error("invalid native media message")
	}
	if body.Type != 7 || body.Media == nil || body.Media.FileInfo != "native-file" || body.Content != "caption" || body.Markdown != nil {
		p.t.Errorf("native media envelope: %+v", body)
	}
	p.messages++
	fmt.Fprint(w, `{"id":"sent"}`)
}

func (p *smallPeer) upload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type int    `json:"file_type"`
		Data string `json:"file_data"`
		Send bool   `json:"srv_send_msg"`
		Name string `json:"file_name"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		p.t.Error("invalid native upload")
	}
	if body.Data != "YWJj" || body.Send {
		p.t.Error("small upload sent a message or changed bytes")
	}
	if body.Type == 4 && body.Name != "a_b.bin" {
		p.t.Error("file filename lost")
	}
	if body.Type != 4 && body.Name != "" {
		p.t.Error("filename belongs only to native file uploads")
	}
	p.types = append(p.types, body.Type)
	fmt.Fprint(w, `{"file_uuid":"native","file_info":"native-file","ttl":0}`)
}

// Small uploads have their own native numbering and must not use srv_send_msg,
// because final delivery belongs to the later message POST. Chunked tests never
// call this JSON/base64 endpoint. The HTTP peer models no relay behavior.
func TestNativeSmallUploadsPreserveMediaTypeAndSeparateSend(t *testing.T) {
	// Verified SDK 1.0.5 protocol/api/media.ts and protocol/types.ts.
	// https://github.com/tencent-connect/qqbot-nodejs
	p := &smallPeer{t: t}
	c, _ := testChannel(t, redirectedClient(t, p))
	for _, fixture := range []struct {
		kind model.MediaKind
		mime string
	}{{model.Image, "image/png"}, {model.Video, "video/mp4"}, {model.Audio, "audio/silk"}, {model.File, "application/octet-stream"}} {
		input := sendInput(c, "c2c")
		input.Chunk.Text = "caption"
		ref := model.MediaReference{ID: "media", Kind: fixture.kind, MIMEType: fixture.mime, FileName: "a/b.bin", Size: 3}
		input.Chunk.Media = &ref
		input.Media = &model.StoredMedia{Reference: ref, Data: []byte("abc")}
		result, err := c.Send(context.Background(), input)
		if err != nil || result.Status != model.Sent {
			t.Fatalf("small media: %+v %v", result, err)
		}
	}
	if fmt.Sprint(p.types) != "[1 2 3 4]" || p.messages != 4 {
		t.Fatalf("native uploads/sends: %v/%d", p.types, p.messages)
	}
}
