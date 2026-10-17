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

// Media labels are flattened from their native Markdown children. Simple label
// coverage misses nested formatting, code soft breaks and autolinks; replacing
// deprecated AST text extraction must retain all three without a test seam.
// https://spec.commonmark.org/0.31.2/#images
func TestRichMediaLabelRetainsNestedSourceText(t *testing.T) {
	parts, err := text.ParseRichMarkdown("![alt *label* `a\nb` <https://example.com> &amp;](relanox://attachment/1)")
	if err != nil || len(parts) != 1 || parts[0].Media == nil {
		t.Fatalf("media: %#v %v", parts, err)
	}
	if parts[0].Media.Label != "alt label a\nb https://example.com &" {
		t.Fatalf("label: %q", parts[0].Media.Label)
	}
}
