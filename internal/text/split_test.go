package text_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
	"github.com/yuin/goldmark"
)

// These tests protect observable native length/Markdown contracts: slicing bytes
// corrupts Unicode, counting source misses rendered overhead, and reopening raw
// delimiters loses links/code. No earlier Go text coverage exists and no seam is
// introduced. CommonMark fixtures follow https://spec.commonmark.org/0.31.2/.
func TestUnicodeAndClosedFormatting(t *testing.T) {
	if text.Length("a😀中", model.UTF8) != 8 || text.Length("a😀中", model.UTF16) != 4 || text.Length("a😀中", model.Codepoint) != 3 {
		t.Fatal("incorrect native length units")
	}
	parts, err := text.SplitMarkdown("**"+strings.Repeat("字", 40)+"**", 34, model.UTF8)
	if err != nil || len(parts) != 4 {
		t.Fatalf("split: %v %#v", err, parts)
	}
	for _, part := range parts {
		if part != "**"+strings.Repeat("字", 10)+"**" {
			t.Fatalf("broken emphasis: %q", part)
		}
	}
	code := strings.Repeat("😀中文\n", 12)
	parts, err = text.SplitMarkdown("```go\n"+code+"```", 48, model.UTF8)
	if err != nil {
		t.Fatal(err)
	}
	var joined string
	for _, part := range parts {
		if len(part) > 48 || !strings.HasPrefix(part, "```go\n") || !strings.HasSuffix(part, "\n```") {
			t.Fatalf("broken fence: %q", part)
		}
		joined += strings.TrimSuffix(strings.TrimPrefix(part, "```go\n"), "\n```")
	}
	if joined != strings.TrimSuffix(code, "\n") {
		t.Fatal("lost code content")
	}
}

func TestLinksAndRenderedLimit(t *testing.T) {
	parts, err := text.SplitMarkdown("[first][doc]\n\n[second][doc]\n\n[doc]: https://example.com", 35, model.UTF16)
	if err != nil || len(parts) != 2 || parts[0] != "[first](<https://example.com>)" || parts[1] != "[second](<https://example.com>)" {
		t.Fatalf("unresolved references: %v %#v", err, parts)
	}
	if _, err = text.SplitMarkdown("[link](https://example.com/"+strings.Repeat("x", 100)+")", 40, model.UTF8); err == nil {
		t.Fatal("oversized link silently lost destination")
	}
	render := func(s string) string {
		var b bytes.Buffer
		if err := goldmark.Convert([]byte(s), &b); err != nil {
			t.Fatal(err)
		}
		return b.String()
	}
	parts, err = text.SplitByRendered("**&&&&&&&&&&&&**", 48, model.UTF8, render)
	if err != nil || len(parts) < 2 {
		t.Fatalf("rendered split: %v %#v", err, parts)
	}
	for _, part := range parts {
		if len(render(part)) > 48 {
			t.Fatal("rendered limit exceeded")
		}
	}
}

func TestLiteralEntitiesSurviveSplit(t *testing.T) {
	for _, source := range []string{"&amp;copy; ", `\&copy; `, "&amp;#169; "} {
		parts, err := text.SplitMarkdown(strings.Repeat(source, 40), 70, model.UTF8)
		if err != nil {
			t.Fatal(err)
		}
		for _, part := range parts {
			var b bytes.Buffer
			if err := goldmark.Convert([]byte(part), &b); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(b.String(), "©") {
				t.Fatalf("entity decoded twice: %q", part)
			}
		}
	}
	if _, err := text.SplitMarkdown(string([]byte{0xff}), 10, model.UTF8); err == nil {
		t.Fatal("accepted invalid UTF-8")
	}
}

func TestHardBreakRemainsVisibleWhenLongDocumentIsSplit(t *testing.T) {
	// CommonMark hard breaks must retain their two spaces when AST splitting is
	// triggered by an unrelated long block. Softening this break changes HTML.
	parts, err := text.SplitMarkdown(strings.Repeat("x", 40)+"\n\nline  \nnext", 14, model.UTF8)
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for _, part := range parts {
		var b bytes.Buffer
		if err := goldmark.Convert([]byte(part), &b); err != nil {
			t.Fatal(err)
		}
		output.Write(b.Bytes())
	}
	if !strings.Contains(output.String(), "line<br>\nnext") {
		t.Fatalf("hard break lost: %s", output.String())
	}
}

// Splitting an unrelated long paragraph must preserve the normalized literal
// contents of an inline code span. Existing split tests exercise fenced code
// only, so they miss loss of inline code children during AST text extraction.
func TestCodeSpanTextSurvivesDocumentSplitting(t *testing.T) {
	parts, err := text.SplitMarkdown(strings.Repeat("x", 40)+"\n\n`a\nb &amp;`", 20, model.UTF8)
	if err != nil || len(parts) != 3 || parts[2] != "`a b &amp;`" {
		t.Fatalf("inline code: %#v %v", parts, err)
	}
}
