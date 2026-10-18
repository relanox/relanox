package discord

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/model"
)

// Components V2 uses Media Gallery descriptions (1024 UTF-16 units) rather
// than embed titles. Existing media fixtures miss rich native component types,
// flags and long descriptions. Public Send uses the existing HTTP peer.
// https://docs.discord.com/developers/components/reference#media-gallery
func TestRichImageDescriptionUnicodeLimit(t *testing.T) {
	p := &nativePeer{t: t, identifies: make(chan map[string]any, 8), sends: make(chan map[string]any, 8)}
	peer := httptest.NewTLSServer(http.HandlerFunc(p.serve))
	p.origin = peer.URL
	defer peer.Close()
	f := startDiscordRelay(t, peer, filepath.Join(t.TempDir(), "discord.db"), false)
	defer f.close(t)
	resolved, err := f.channel.Resolve(context.Background(), model.ChannelAddress{Platform: model.Discord, AccountID: "discord", ChatID: "400", ThreadID: "300"}, nil)
	if err != nil || !resolved.Available || resolved.Target == nil {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	media := model.StoredMedia{Reference: model.MediaReference{ID: "media", Kind: model.Image, MIMEType: "image/png", FileName: "photo.PNG", Size: 5}, Data: []byte("image")}
	input := model.SendInput{Target: *resolved.Target, Chunk: model.DeliveryChunk{IdempotencyKey: "rich-title"}, RichMedia: []model.StoredMedia{media}}
	for _, label := range []string{strings.Repeat("图", 1024), strings.Repeat("😀", 512)} {
		input.Chunk.RichText = []model.RichTextPart{{Type: "text", Text: "**first**"}, {Type: "image", Label: label, Media: &media.Reference}, {Type: "text", Text: "last"}}
		result, err := f.channel.Send(t.Context(), input)
		if err != nil || result.Status != model.Sent {
			t.Fatalf("valid Unicode title rejected: %+v %v", result, err)
		}
		payload := <-p.sends
		components, _ := payload["components"].([]any)
		if len(components) != 3 || payload["flags"] != float64(32768) {
			t.Fatalf("native embeds: %+v", payload)
		}
		first := components[0].(map[string]any)
		last := components[2].(map[string]any)
		if first["type"] != float64(10) || first["content"] != "**first**" || last["type"] != float64(10) || last["content"] != "last" {
			t.Fatal("native text component ordering changed")
		}
		gallery, _ := components[1].(map[string]any)
		items := gallery["items"].([]any)
		item := items[0].(map[string]any)
		if item["description"] != label || gallery["type"] != float64(12) {
			t.Fatal("native title changed")
		}
		if item["media"].(map[string]any)["url"] != "attachment://image-0.png" {
			t.Fatal("native attachment extension changed")
		}
	}
	before := p.sendCalls.Load()
	input.Chunk.RichText[1].Label = strings.Repeat("😀", 2001)
	result, err := f.channel.Send(t.Context(), input)
	if err != nil || result.Status != model.Sent || p.sendCalls.Load() != before+1 {
		t.Fatalf("oversized title reached native send: %+v %v", result, err)
	}
	payload := <-p.sends
	gallery := payload["components"].([]any)[1].(map[string]any)
	item := gallery["items"].([]any)[0].(map[string]any)
	if item["description"] != strings.Repeat("😀", 512) {
		t.Fatal("description was not truncated at a complete UTF-16 boundary")
	}
	assertUploadBounds(t, f, p, input.Target)
}

// Source Discord upload budgets are independent of the host's larger storage
// limit: 10 MiB per rich image, 20 MiB across rich images, 20 MiB plain uploads.
// Existing five-byte fixtures cannot expose accidental use of only the host cap.
func assertUploadBounds(t *testing.T, f *discordRelay, p *nativePeer, target model.ReplyTarget) {
	t.Helper()
	for _, fixture := range []struct {
		name        string
		size, count int
		plain       bool
	}{{"rich-single", 10<<20 + 1, 1, false}, {"rich-total", 7 << 20, 3, false}, {"plain-upload", 20<<20 + 1, 1, true}} {
		t.Run(fixture.name, func(t *testing.T) {
			media := model.StoredMedia{Reference: model.MediaReference{ID: "large", Kind: model.Image, MIMEType: "image/png", FileName: "large.png", Size: int64(fixture.size)}, Data: make([]byte, fixture.size)}
			input := model.SendInput{Target: target, Chunk: model.DeliveryChunk{IdempotencyKey: "bounded"}}
			if fixture.plain {
				input.Media = &media
				input.Chunk.Media = &media.Reference
			} else {
				for range fixture.count {
					input.RichMedia = append(input.RichMedia, media)
					input.Chunk.RichText = append(input.Chunk.RichText, model.RichTextPart{Type: "image", Media: &media.Reference})
				}
			}
			before := p.sendCalls.Load()
			result, err := f.channel.Send(t.Context(), input)
			if err != nil || result.Status != model.Rejected || p.sendCalls.Load() != before {
				t.Fatalf("oversized upload transmitted: %+v %v", result, err)
			}
		})
	}
}
