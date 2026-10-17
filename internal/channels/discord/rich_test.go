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

// Embed titles allow 256 characters, independently of their UTF-8 byte size.
// https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx#embed-limits
// discord.js 14.25.1 titlePredicate uses JS string length (UTF-16 units):
// https://github.com/discordjs/discord.js/blob/14.25.1/packages/builders/src/messages/embed/Assertions.ts
// Existing multipart tests send plain media without a rich image label. Exercise
// the public Send path and inspect native multipart JSON so a byte-count guard
// cannot reject valid Chinese titles. The existing peer adds no production seam.
func TestRichImageTitleUnicodeLimit(t *testing.T) {
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
	media := model.StoredMedia{Reference: model.MediaReference{ID: "media", Kind: model.Image, MIMEType: "image/png", FileName: "photo.png", Size: 5}, Data: []byte("image")}
	input := model.SendInput{Target: *resolved.Target, Chunk: model.DeliveryChunk{IdempotencyKey: "rich-title"}, RichMedia: []model.StoredMedia{media}}
	for _, label := range []string{strings.Repeat("图", 256), strings.Repeat("😀", 128)} {
		input.Chunk.RichText = []model.RichTextPart{{Type: "image", Label: label, Media: &media.Reference}}
		result, err := f.channel.Send(t.Context(), input)
		if err != nil || result.Status != model.Sent {
			t.Fatalf("valid Unicode title rejected: %+v %v", result, err)
		}
		payload := <-p.sends
		embeds, _ := payload["embeds"].([]any)
		if len(embeds) != 1 {
			t.Fatalf("native embeds: %+v", payload)
		}
		embed, _ := embeds[0].(map[string]any)
		if embed["title"] != label {
			t.Fatal("native title changed")
		}
	}
	before := p.sendCalls.Load()
	input.Chunk.RichText[0].Label = strings.Repeat("图", 257)
	result, err := f.channel.Send(t.Context(), input)
	if err != nil || result.Status != model.Rejected || p.sendCalls.Load() != before {
		t.Fatalf("oversized title reached native send: %+v %v", result, err)
	}
}
