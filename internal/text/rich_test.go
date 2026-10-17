package text_test

import (
	"testing"

	"github.com/relanox/relanox/internal/text"
)

// Explicit relay media syntax is a public send contract. Reading order and
// balanced formatting would be lost by raw string replacement; code literals
// must never become attachments. Existing split tests cover no media extraction.
func TestRichMediaReferencesRetainOrderAndClosedFormatting(t *testing.T) {
	parts, err := text.ParseRichMarkdown("**before ![photo](relanox://attachment/2) after**\n\n[file](relanox://media/00112233-4455-6677-8899-aabbccddeeff)")
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != 4 || parts[0].Text != "**before** " || parts[1].Media == nil || parts[1].Media.Attachment != 2 || !parts[1].Media.Image || parts[2].Text != " **after**\n\n" || parts[3].Media == nil || parts[3].Media.ID != "00112233-4455-6677-8899-aabbccddeeff" {
		t.Fatalf("rich order: %#v", parts)
	}
}

func TestLiteralMediaSyntaxAndInvalidReference(t *testing.T) {
	for _, source := range []string{"`![literal](relanox://attachment/1)`", "![remote](https://example.com/image.png)", "normal **Markdown**"} {
		parts, err := text.ParseRichMarkdown(source)
		if err != nil || len(parts) != 1 || parts[0].Text != source || parts[0].Media != nil {
			t.Fatalf("ordinary content rewritten: %#v %v", parts, err)
		}
	}
	if _, err := text.ParseRichMarkdown("[bad](relanox://attachment/0)"); err == nil {
		t.Fatal("invalid native numbering accepted")
	}
}
