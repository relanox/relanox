package text

import (
	"bytes"
	"net/url"
	"strconv"
	"strings"

	"github.com/relanox/relanox/internal/model"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	gmtext "github.com/yuin/goldmark/text"
)

// Run is visible text with native formatting, independent of a platform's markup.
type Run struct {
	Text                            string
	Bold, Italic, Strike, Code, Pre bool
	Language, Href                  string
}

type runBuilder struct{ runs []Run }

func (b *runBuilder) append(value string, style Run) {
	if value == "" {
		return
	}
	style.Text = ""
	if n := len(b.runs); n > 0 {
		last := b.runs[n-1]
		last.Text = ""
		if last == style {
			b.runs[n-1].Text += value
			return
		}
	}
	style.Text = value
	b.runs = append(b.runs, style)
}

func (b *runBuilder) separator(value string) {
	if len(b.runs) == 0 {
		return
	}
	last := b.runs[len(b.runs)-1].Text
	if strings.HasSuffix(last, value) {
		return
	}
	if value == "\n\n" && strings.HasSuffix(last, "\n") {
		value = "\n"
	}
	b.append(value, Run{})
}

func safeLink(value string) string {
	u, err := url.Parse(value)
	if err != nil {
		return ""
	}
	if !strings.ContainsAny(value, "\r\n\x00") && (u.Scheme == "https" || u.Scheme == "http" || u.Scheme == "mailto" || u.Scheme == "tg") {
		return value
	}
	return ""
}

// Runs parses CommonMark/GFM once and preserves the visible text of unsupported
// formatting. User HTML remains literal text; it is never treated as trusted HTML.
func Runs(value string) []Run {
	source := []byte(value)
	document := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(gmtext.NewReader(source))
	b := runBuilder{}
	b.node(document, source, Run{}, 0)
	for len(b.runs) > 0 {
		i := len(b.runs) - 1
		b.runs[i].Text = strings.TrimRight(b.runs[i].Text, "\n")
		if b.runs[i].Text != "" {
			break
		}
		b.runs = b.runs[:i]
	}
	return b.runs
}

func (b *runBuilder) children(n ast.Node, source []byte, style Run, depth int) {
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		b.node(child, source, style, depth+1)
	}
}

func (b *runBuilder) node(n ast.Node, source []byte, style Run, depth int) {
	if depth > 128 {
		b.append(string(nodeText(n, source)), style)
		return
	}
	if b.inline(n, source, style, depth) {
		return
	}
	switch value := n.(type) {
	case *ast.FencedCodeBlock:
		b.separator("\n\n")
		style.Pre = true
		style.Code = false
		style.Language = string(value.Language(source))
		b.append(blockLines(value, source), style)
		b.separator("\n\n")
	case *ast.CodeBlock:
		b.separator("\n\n")
		style.Pre = true
		b.append(blockLines(value, source), style)
		b.separator("\n\n")
	case *ast.Heading:
		b.separator("\n\n")
		style.Bold = true
		b.children(n, source, style, depth)
		b.separator("\n\n")
	case *ast.Paragraph:
		b.children(n, source, style, depth)
		b.separator("\n\n")
	case *ast.ListItem:
		b.separator("\n")
		b.append(listMarker(value), Run{})
		b.children(n, source, style, depth)
		b.separator("\n")
	case *ast.ThematicBreak:
		b.separator("\n\n")
		b.append("---", Run{})
		b.separator("\n\n")
	case *ast.HTMLBlock:
		b.append(blockLines(value, source), style)
	case *extast.TableRow, *extast.TableHeader:
		b.separator("\n")
		b.children(n, source, style, depth)
		b.separator("\n")
	case *extast.TableCell:
		if n.PreviousSibling() != nil {
			b.append("\t", Run{})
		}
		b.children(n, source, style, depth)
	default:
		b.children(n, source, style, depth)
	}
}

func (b *runBuilder) inline(n ast.Node, source []byte, style Run, depth int) bool {
	switch value := n.(type) {
	case *ast.Text:
		b.append(decoded(value.Value(source)), style)
		if value.HardLineBreak() || value.SoftLineBreak() {
			b.append("\n", style)
		}
	case *ast.String:
		b.append(decoded(value.Value), style)
	case *ast.Emphasis:
		if value.Level == 2 {
			style.Bold = true
		} else {
			style.Italic = true
		}
		b.children(n, source, style, depth)
	case *extast.Strikethrough:
		style.Strike = true
		b.children(n, source, style, depth)
	case *ast.CodeSpan:
		style.Code = true
		b.append(strings.ReplaceAll(string(nodeText(value, source)), "\n", " "), style)
	case *ast.Link:
		style.Href = safeLink(string(value.Destination))
		b.children(n, source, style, depth)
	case *ast.Image:
		b.children(n, source, style, depth)
	case *ast.AutoLink:
		style.Href = safeLink(string(value.URL(source)))
		b.append(string(value.Label(source)), style)
	case *ast.RawHTML:
		for i := 0; i < value.Segments.Len(); i++ {
			segment := value.Segments.At(i)
			b.append(string(segment.Value(source)), style)
		}
	default:
		return false
	}
	return true
}

func blockLines(n ast.Node, source []byte) string {
	var out strings.Builder
	for i := 0; i < n.Lines().Len(); i++ {
		line := n.Lines().At(i)
		out.Write(line.Value(source))
	}
	return out.String()
}

// nodeText collects the unrendered text of a node, retaining source segments
// and soft breaks when flattening link labels, code spans or deep formatting.
func nodeText(n ast.Node, source []byte) []byte {
	switch value := n.(type) {
	case *ast.Text:
		return value.Value(source)
	case *ast.String:
		return value.Value
	case *ast.AutoLink:
		return value.Label(source)
	case *ast.RawHTML:
		return value.Segments.Value(source)
	case *ast.HTMLBlock:
		text := append([]byte(nil), value.Lines().Value(source)...)
		if value.HasClosure() {
			text = append(text, value.ClosureLine.Value(source)...)
		}
		return text
	case *ast.Paragraph, *ast.TextBlock, *ast.CodeBlock, *ast.FencedCodeBlock:
		return n.Lines().Value(source)
	}
	var text bytes.Buffer
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		text.Write(nodeText(child, source))
		if value, ok := child.(*ast.Text); ok && value.SoftLineBreak() {
			text.WriteByte('\n')
		}
	}
	return text.Bytes()
}

func listMarker(item *ast.ListItem) string {
	list, ok := item.Parent().(*ast.List)
	if !ok || !list.IsOrdered() {
		return "• "
	}
	number := list.Start
	for prior := item.PreviousSibling(); prior != nil; prior = prior.PreviousSibling() {
		number++
	}
	return strconv.Itoa(number) + ". "
}

type TelegramEntity struct {
	Type     string `json:"type"`
	Offset   int    `json:"offset"`
	Length   int    `json:"length"`
	URL      string `json:"url,omitempty"`
	Language string `json:"language,omitempty"`
}

type TelegramText struct {
	Text     string           `json:"text"`
	Entities []TelegramEntity `json:"entities,omitempty"`
}

// Telegram counts visible characters by code point, but entities by UTF-16 units.
func Telegram(value string) TelegramText {
	var out TelegramText
	offset := 0
	for _, run := range Runs(value) {
		length := Length(run.Text, model.UTF16)
		for _, entity := range runEntities(run) {
			entity.Offset = offset
			entity.Length = length
			out.Entities = append(out.Entities, entity)
		}
		out.Text += run.Text
		offset += length
	}
	return out
}

func runEntities(run Run) []TelegramEntity {
	if run.Pre {
		return []TelegramEntity{{Type: "pre", Language: run.Language}}
	}
	if run.Code {
		return []TelegramEntity{{Type: "code"}}
	}
	var out []TelegramEntity
	for _, decoration := range []struct {
		enabled bool
		kind    string
	}{{run.Bold, "bold"}, {run.Italic, "italic"}, {run.Strike, "strikethrough"}} {
		if decoration.enabled {
			out = append(out, TelegramEntity{Type: decoration.kind})
		}
	}
	if run.Href != "" {
		out = append(out, TelegramEntity{Type: "text_link", URL: run.Href})
	}
	return out
}

func Slack(value string) string {
	var out strings.Builder
	for _, run := range Runs(value) {
		s := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(run.Text)
		s = slackStyle(s, run)
		out.WriteString(s)
	}
	return out.String()
}

func slackStyle(value string, run Run) string {
	if run.Pre {
		return "```" + strings.ReplaceAll(value, "```", "``\u200b`") + "```"
	}
	if run.Code {
		return "`" + strings.ReplaceAll(value, "`", "ˋ") + "`"
	}
	if run.Bold {
		value = "*" + value + "*"
	}
	if run.Italic {
		value = "_" + value + "_"
	}
	if run.Strike {
		value = "~" + value + "~"
	}
	if run.Href != "" {
		value = "<" + strings.NewReplacer("&", "&amp;", ">", "%3E", "|", "%7C").Replace(run.Href) + "|" + strings.ReplaceAll(value, "|", "¦") + ">"
	}
	return value
}

// Matrix produces safe formatted_body HTML from the same parsed document.
func Matrix(value string) string {
	var out bytes.Buffer
	_ = goldmark.New(goldmark.WithExtensions(extension.GFM)).Convert([]byte(value), &out)
	return out.String()
}

// Plain renders only visible text, for platform protocols without Markdown.
func Plain(value string) string {
	var out strings.Builder
	for _, run := range Runs(value) {
		out.WriteString(run.Text)
	}
	return out.String()
}
