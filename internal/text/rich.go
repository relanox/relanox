package text

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	gmtext "github.com/yuin/goldmark/text"
)

type MediaReference struct {
	ID         string
	Attachment int // Native attachment positions are one based.
	Label      string
	Image      bool
}

type RichPart struct {
	Text  string
	Media *MediaReference
}

var attachmentURL = regexp.MustCompile(`(?i)^relanox://attachment/([1-9][0-9]*)$`)

// ParseRichMarkdown extracts only explicit relay-owned references. Normal remote
// links/images are never downloaded. Markdown without relay media is unchanged.
func ParseRichMarkdown(source string) ([]RichPart, error) {
	if !utf8.ValidString(source) {
		return nil, errors.New("malformed_markdown_unicode")
	}
	data := []byte(source)
	parser := goldmark.New(goldmark.WithExtensions(extension.GFM))
	document := parser.Parser().Parse(gmtext.NewReader(data))
	found := false
	err := ast.Walk(document, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			destination, _, ok := nodeLink(n)
			if ok && strings.HasPrefix(strings.ToLower(decoded(destination)), "relanox:") {
				found = true
			}
		}
		return ast.WalkContinue, nil
	})
	if err != nil {
		return nil, err
	}
	if !found {
		return []RichPart{{Text: source}}, nil
	}
	return richChildren(document, data, "\n\n", 0)
}

func nodeLink(n ast.Node) ([]byte, bool, bool) {
	switch value := n.(type) {
	case *ast.Link:
		return value.Destination, false, true
	case *ast.Image:
		return value.Destination, true, true
	}
	return nil, false, false
}

func richChildren(n ast.Node, source []byte, separator string, depth int) ([]RichPart, error) {
	if depth > 64 {
		return nil, errors.New("markdown_nesting_too_deep")
	}
	var parts []RichPart
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		if len(parts) > 0 && separator != "" {
			parts = appendRich(parts, RichPart{Text: separator})
		}
		children, err := richNode(child, source, depth+1)
		if err != nil {
			return nil, err
		}
		for _, part := range children {
			parts = appendRich(parts, part)
		}
	}
	return parts, nil
}

func appendRich(parts []RichPart, part RichPart) []RichPart {
	if part.Media == nil && part.Text == "" {
		return parts
	}
	if len(parts) > 0 && part.Media == nil && parts[len(parts)-1].Media == nil {
		parts[len(parts)-1].Text += part.Text
		return parts
	}
	return append(parts, part)
}

func richWrapped(n ast.Node, source []byte, depth int, separator string, wrap func(string) string) ([]RichPart, error) {
	parts, err := richChildren(n, source, separator, depth)
	if err != nil {
		return nil, err
	}
	for i := range parts {
		if parts[i].Media == nil {
			parts[i].Text = wrap(parts[i].Text)
		}
	}
	return parts, nil
}

func mediaReference(destination []byte, image bool, label string) (*MediaReference, error) {
	href := decoded(destination)
	if !strings.HasPrefix(strings.ToLower(href), "relanox:") {
		return nil, nil
	}
	ref := &MediaReference{Image: image, Label: label}
	if strings.HasPrefix(strings.ToLower(href), "relanox://media/") {
		id := href[len("relanox://media/"):]
		parsed, err := uuid.Parse(id)
		if err != nil || len(id) != 36 {
			return nil, errors.New("invalid_media_reference")
		}
		ref.ID = parsed.String()
		return ref, nil
	}
	match := attachmentURL.FindStringSubmatch(href)
	if match != nil {
		index, err := strconv.Atoi(match[1])
		if err != nil {
			return nil, errors.New("invalid_media_reference")
		}
		ref.Attachment = index
		return ref, nil
	}
	return nil, errors.New("invalid_media_reference")
}

func richNode(n ast.Node, source []byte, depth int) ([]RichPart, error) {
	if destination, image, ok := nodeLink(n); ok {
		ref, err := mediaReference(destination, image, decoded(nodeText(n, source)))
		if err != nil {
			return nil, err
		}
		if ref != nil {
			return []RichPart{{Media: ref}}, nil
		}
		prefix := "["
		if image {
			prefix = "!["
		}
		href := strings.NewReplacer("<", "%3C", ">", "%3E", "\n", "%0A").Replace(decoded(destination))
		return richWrapped(n, source, depth, "", func(s string) string { return prefix + s + "](<" + href + ">)" })
	}
	switch value := n.(type) {
	case *ast.Text:
		s := string(value.Value(source))
		if value.HardLineBreak() {
			s += "  \n"
		} else if value.SoftLineBreak() {
			s += "\n"
		}
		return []RichPart{{Text: s}}, nil
	case *ast.String:
		return []RichPart{{Text: string(value.Value)}}, nil
	case *ast.Emphasis:
		marker := strings.Repeat("*", value.Level)
		return richWrapped(n, source, depth, "", func(s string) string {
			content := strings.TrimSpace(s)
			if content == "" {
				return s
			}
			start := strings.Index(s, content)
			return s[:start] + marker + content + marker + s[start+len(content):]
		})
	case *extast.Strikethrough:
		return richWrapped(n, source, depth, "", func(s string) string {
			if strings.TrimSpace(s) == "" {
				return s
			}
			return "~~" + s + "~~"
		})
	}
	return richBlock(n, source, depth)
}

func richBlock(n ast.Node, source []byte, depth int) ([]RichPart, error) {
	switch value := n.(type) {
	case *ast.Heading:
		return richWrapped(n, source, depth, "", func(s string) string { return strings.Repeat("#", value.Level) + " " + s })
	case *ast.Blockquote:
		return richWrapped(n, source, depth, "\n\n", func(s string) string { return "> " + strings.ReplaceAll(s, "\n", "\n> ") })
	case *ast.List:
		return richList(value, source, depth)
	case *ast.Paragraph, *ast.TextBlock:
		return richChildren(n, source, "", depth)
	case *extast.Table:
		return richChildren(n, source, "\n", depth)
	case *extast.TableHeader, *extast.TableRow:
		return richChildren(n, source, " | ", depth)
	case *extast.TableCell:
		return richChildren(n, source, "", depth)
	}
	parts, err := nodeParts(n, source, func(string) bool { return true }, depth)
	if err != nil {
		return nil, err
	}
	return []RichPart{{Text: strings.Join(parts, "")}}, nil
}

func richList(n *ast.List, source []byte, depth int) ([]RichPart, error) {
	var parts []RichPart
	number := n.Start
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		prefix := "- "
		if n.IsOrdered() {
			prefix = fmt.Sprintf("%d. ", number)
			number++
		}
		item, err := richWrapped(child, source, depth, "\n\n", func(s string) string {
			return prefix + strings.ReplaceAll(s, "\n", "\n"+strings.Repeat(" ", len(prefix)))
		})
		if err != nil {
			return nil, err
		}
		for _, part := range item {
			parts = appendRich(parts, part)
		}
		parts = appendRich(parts, RichPart{Text: "\n"})
	}
	return parts, nil
}
