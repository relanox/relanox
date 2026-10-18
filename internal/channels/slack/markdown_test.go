package slack

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/model"
)

// Block Kit rich_text carries literal text, styles and links separately. The
// old media-only fixture could not detect mrkdwn reinterpreting escaped text.
// Native request inspection uses the existing protocol peer and real storage.
// https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/
func TestLiteralStyledMarkdownNativePayload(t *testing.T) {
	p, peer := newNativePeer(t)
	defer peer.Close()
	f := startSlackRelay(t, peer, filepath.Join(t.TempDir(), "slack.db"), false, false)
	defer f.close(t)
	resolved, err := f.channel.Resolve(t.Context(), model.ChannelAddress{Platform: model.Slack, AccountID: "slack", ChatID: "C1", ThreadID: "1700000000.000001"}, nil)
	if err != nil || resolved.Target == nil {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	input := model.SendInput{Target: *resolved.Target, Chunk: model.DeliveryChunk{IdempotencyKey: "styled", Text: "\\*literal\\* **bold** [site](https://example.com)"}}
	result, err := f.channel.Send(t.Context(), input)
	if err != nil || result.Status != model.Sent {
		t.Fatalf("send: %+v %v", result, err)
	}
	post := <-p.posts
	if post.Get("mrkdwn") != "false" || post.Get("text") != "*literal* bold site (https://example.com)" {
		t.Fatalf("fallback: %+v", post)
	}
	var blocks []struct {
		Type     string `json:"type"`
		Elements []struct {
			Elements []struct {
				Type  string          `json:"type"`
				Text  string          `json:"text"`
				URL   string          `json:"url"`
				Style map[string]bool `json:"style"`
			} `json:"elements"`
		} `json:"elements"`
	}
	if json.Unmarshal([]byte(post.Get("blocks")), &blocks) != nil || len(blocks) != 1 || blocks[0].Type != "rich_text" || len(blocks[0].Elements) != 1 {
		t.Fatalf("blocks: %s", post.Get("blocks"))
	}
	elements := blocks[0].Elements[0].Elements
	if len(elements) != 4 || elements[0].Text != "*literal* " || elements[0].Style["bold"] || elements[1].Text != "bold" || !elements[1].Style["bold"] || elements[3].Type != "link" || elements[3].URL != "https://example.com" {
		t.Fatalf("literal/styles/link: %+v", elements)
	}
}

// Source adapter used a 4000-byte entire JSON request budget. A short ASCII
// fixture cannot expose UTF-8, escaping, style overhead or target identifiers.
func TestSplitIncludesNativePayloadBudget(t *testing.T) {
	p, peer := newNativePeer(t)
	defer peer.Close()
	f := startSlackRelay(t, peer, filepath.Join(t.TempDir(), "slack.db"), false, false)
	defer f.close(t)
	resolved, err := f.channel.Resolve(t.Context(), model.ChannelAddress{Platform: model.Slack, AccountID: "slack", ChatID: "C1", ThreadID: "1700000000.000001"}, nil)
	if err != nil || resolved.Target == nil {
		t.Fatalf("resolve: %+v %v", resolved, err)
	}
	parts, err := f.channel.SplitText(strings.Repeat("图", 1000), *resolved.Target)
	if err != nil || len(parts) < 2 {
		t.Fatalf("UTF-8 request was not split: %d %v", len(parts), err)
	}
	if strings.Join(parts, "") != strings.Repeat("图", 1000) {
		t.Fatal("split lost visible text")
	}
	for _, part := range parts {
		result, err := f.channel.Send(t.Context(), model.SendInput{Target: *resolved.Target, Chunk: model.DeliveryChunk{IdempotencyKey: "budget", Text: part}})
		if err != nil || result.Status != model.Sent {
			t.Fatalf("split fragment rejected: %+v %v", result, err)
		}
		post := <-p.posts
		// Measure the native fields observed on HTTP, independently of the
		// splitter's renderer. Slack SDK uses form encoding for these same fields.
		payload, err := json.Marshal(map[string]any{"channel": post.Get("channel"), "text": post.Get("text"), "blocks": json.RawMessage(post.Get("blocks")), "mrkdwn": false, "parse": post.Get("parse"), "unfurl_links": false, "unfurl_media": false, "thread_ts": post.Get("thread_ts")})
		if err != nil || len(payload) > 4000 {
			t.Fatalf("native JSON budget: %d %v", len(payload), err)
		}
	}
}
