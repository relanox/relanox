package googlechat

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

func payloadFixture(t *testing.T) (*fixture, *googlePeer, model.ChannelAddress, model.ReplyTarget, *model.StoredMedia) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &googlePeer{t: t, key: key, sends: make(chan nativeSend, 16), started: make(chan struct{})}
	peer := httptest.NewServer(p)
	t.Cleanup(peer.Close)
	base, _ := url.Parse(peer.URL)
	f := newFixture(t, p, filepath.Join(t.TempDir(), "payload.db"), &http.Client{Transport: rewriteTransport{base: base, next: peer.Client().Transport}})
	status, err := f.scoped.Status(context.Background(), model.StatusInput{})
	if err != nil || len(status.Channels) != 1 {
		t.Fatalf("configured channel: %+v %v", status, err)
	}
	address := status.Channels[0].Channel
	resolved, err := f.channel.Resolve(context.Background(), address, nil)
	if err != nil || !resolved.Available {
		t.Fatalf("target: %+v %v", resolved, err)
	}
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	ref, err := f.scoped.Media().Upload(context.Background(), address.ID, uuid.NewString(), model.MediaUpload{Kind: model.Image, MIMEType: "image/png", FileName: "pixel.png", Data: data})
	if err != nil {
		t.Fatal(err)
	}
	media, err := f.scoped.Media().Read(context.Background(), address.ID, ref.ID)
	if err != nil || media == nil {
		t.Fatalf("owned image: %+v %v", media, err)
	}
	return f, p, address, *resolved.Target, media
}

// Protects permanent native payload rejection and the 32k serialized request
// bound. HTML/JSON escaping can overflow native bytes while visible text is
// within the advertised limit; retrying it can never succeed. Other protocol
// tests send small valid messages only. Actual Core publications and the native
// HTTP peer prove invalid sends never create a message, with no new seam.
func TestLocalPayloadFailuresRejectBeforeNativeCreate(t *testing.T) {
	f, p, address, target, media := payloadFixture(t)
	rich := []model.RichTextPart{{Type: "text", Text: "x"}, {Type: "image", Media: &media.Reference}}
	for _, row := range []struct {
		chunk     model.DeliveryChunk
		richMedia []model.StoredMedia
		code      string
	}{
		{chunk: model.DeliveryChunk{Media: &media.Reference, IdempotencyKey: "missing-owned-bytes"}, code: "invalid_media"},
		{chunk: model.DeliveryChunk{RichText: rich, IdempotencyKey: "missing-rich-bytes"}, code: "invalid_rich_media"},
		{chunk: model.DeliveryChunk{RichText: []model.RichTextPart{{Type: "text", Text: strings.Repeat("&", 16000)}, {Type: "image", Media: &media.Reference}}, IdempotencyKey: "escaped-card"}, richMedia: []model.StoredMedia{*media}, code: "rich_text_limit_exceeded"},
		{chunk: model.DeliveryChunk{Text: strings.Repeat(`"`, 16000), IdempotencyKey: "escaped-text"}, code: "native_message_too_large"},
	} {
		result, err := f.channel.Send(context.Background(), model.SendInput{ChannelID: address.ID, Target: target, Chunk: row.chunk, RichMedia: row.richMedia})
		if err != nil || result.Status != model.Rejected || result.ErrorCode != row.code {
			t.Fatalf("payload classification: %+v %v, want %s", result, err, row.code)
		}
	}
	if p.requests.Load() != 0 {
		t.Fatal("invalid local payload reached native create")
	}
	assertSerializedSplit(t, f, p, address, target)
	before := p.requests.Load()
	if err := f.store.RegisterConversations(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	result, err := f.channel.Send(context.Background(), model.SendInput{ChannelID: address.ID, Target: target, Chunk: model.DeliveryChunk{Media: &media.Reference, IdempotencyKey: "publication-unavailable"}, Media: media})
	if err != nil || result.Status != model.Retryable || result.ErrorCode != "media_preparation_unavailable" || p.requests.Load() != before {
		t.Fatalf("publication failure: %+v %v", result, err)
	}
}

func assertSerializedSplit(t *testing.T, f *fixture, p *googlePeer, address model.ChannelAddress, target model.ReplyTarget) {
	t.Helper()
	original := strings.Repeat(`"`, 20000)
	parts, err := f.channel.SplitText(original, target)
	if err != nil || len(parts) < 2 {
		t.Fatalf("serialized split: %d %v", len(parts), err)
	}
	var delivered strings.Builder
	for i, part := range parts {
		result, err := f.channel.Send(context.Background(), model.SendInput{ChannelID: address.ID, Target: target, Chunk: model.DeliveryChunk{Text: part, IdempotencyKey: fmt.Sprintf("escaped-%d", i)}})
		if err != nil || result.Status != model.Sent {
			t.Fatalf("serialized chunk: %+v %v", result, err)
		}
		message := <-p.sends
		if len(common.Data(message.Payload)) > 32000 {
			t.Fatal("native serialized message exceeded 32k")
		}
		value, _ := message.Payload["text"].(string)
		delivered.WriteString(value)
	}
	if delivered.String() != original {
		t.Fatal("native split changed visible text")
	}
}
