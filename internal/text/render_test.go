package text

import (
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/model"
)

// Native entities use UTF-16 offsets while Telegram's message bounds count
// visible code points. A byte/rune offset regression silently formats the wrong
// characters after astral Unicode. Splitter tests cannot catch native envelopes;
// this exercises the production renderer without a test-only seam.
// https://core.telegram.org/bots/api#messageentity
func TestTelegramEntitiesAndVisibleLimit(t *testing.T) {
	rendered := Telegram("😀 **bold _字_** [link](https://example.com) `x < y`")
	if rendered.Text != "😀 bold 字 link x < y" {
		t.Fatalf("visible text: %q", rendered.Text)
	}
	checks := []TelegramEntity{{Type: "bold", Offset: 3, Length: 5}, {Type: "bold", Offset: 8, Length: 1}, {Type: "italic", Offset: 8, Length: 1}, {Type: "text_link", Offset: 10, Length: 4, URL: "https://example.com"}, {Type: "code", Offset: 15, Length: 5}}
	if len(rendered.Entities) != len(checks) {
		t.Fatalf("entities: %+v", rendered.Entities)
	}
	for i, want := range checks {
		if rendered.Entities[i] != want {
			t.Fatalf("entity %d: %+v want %+v", i, rendered.Entities[i], want)
		}
	}
	parts, err := SplitByRendered("**"+strings.Repeat("😀", 4097)+"**", 4096, model.Codepoint, func(s string) string { return Telegram(s).Text })
	if err != nil || len(parts) != 2 {
		t.Fatalf("split: %d %v", len(parts), err)
	}
	for _, part := range parts {
		if Length(Telegram(part).Text, model.Codepoint) > 4096 {
			t.Fatal("visible bound exceeded")
		}
	}
}

// Slack requires literal &, < and > escaping to prevent user content becoming
// links or mentions; Matrix must not pass user HTML/javascript through as trusted
// formatted_body. Existing splitting coverage does not render either protocol.
// https://docs.slack.dev/messaging/formatting-message-text/
// https://spec.matrix.org/v1.17/client-server-api/#mroommessage-msgtypes
func TestNativeEscapingAndCode(t *testing.T) {
	if value := Slack("**hello** & <@everyone> [site](https://example.com?a=1&b=2)"); value != "*hello* &amp; &lt;@everyone&gt; <https://example.com?a=1&amp;b=2|site>" {
		t.Fatalf("Slack: %q", value)
	}
	value := Matrix("<script>alert(1)</script>\n\n[unsafe](javascript:alert) **safe**")
	if strings.Contains(value, "<script>") || strings.Contains(value, `href="javascript:`) || !strings.Contains(value, "<strong>safe</strong>") {
		t.Fatalf("Matrix HTML: %s", value)
	}
	rendered := Telegram("```go\nfmt.Println(\"<ok>\")\n```")
	if len(rendered.Entities) != 1 || rendered.Entities[0].Type != "pre" || rendered.Entities[0].Language != "go" || !strings.Contains(rendered.Text, `"<ok>"`) {
		t.Fatalf("code: %+v", rendered)
	}
}

// CommonMark code spans normalize line endings but retain literal entities and
// escape characters. Existing renderer coverage has only single-line code, so
// flattening AST children incorrectly could silently alter native reply text.
// https://spec.commonmark.org/0.31.2/#code-spans
func TestCodeSpanSourceTextSurvivesNativeRendering(t *testing.T) {
	got := Telegram("`a\nb &amp; \\*` ![alt *label*](https://example.com/image) <https://example.com>")
	if got.Text != "a b &amp; \\* alt label https://example.com" {
		t.Fatalf("visible text: %q", got.Text)
	}
	if len(got.Entities) != 3 || got.Entities[0] != (TelegramEntity{Type: "code", Offset: 0, Length: 12}) || got.Entities[1].Type != "italic" || got.Entities[2].URL != "https://example.com" {
		t.Fatalf("native formatting: %+v", got.Entities)
	}
}

// Native text must retain literal HTML, checklist state and useful labels for
// empty links. The TypeScript renderer retained these; previous Go coverage
// tests only inline HTML and nonempty links. These public renderers need no seam.
// HTML closures: https://spec.commonmark.org/0.31.2/#html-blocks
// Task items: https://github.github.com/gfm/#task-list-items-extension-
func TestNativeRenderingPreservesVisibleContent(t *testing.T) {
	for _, fixture := range []struct {
		name, source, want string
	}{
		{"html_closure", "<script>\nliteral\n</script>", "<script>\nliteral\n</script>"},
		{"comment_closure", "<!--\nliteral\n-->", "<!--\nliteral\n-->"},
		{"task_state", "- [x] done\n- [ ] pending", "• [x] done\n• [ ] pending"},
		{"empty_link", "[](https://example.com/path)", "https://example.com/path"},
		{"empty_image", "![](https://example.com/image.png)", "Image"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			if got := Plain(fixture.source); got != fixture.want {
				t.Fatalf("visible text = %q, want %q", got, fixture.want)
			}
		})
	}
}
