// Package text preserves Markdown structure while respecting native length units.
package text

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"html"
	"strings"
	"unicode/utf8"

	"github.com/relanox/relanox/internal/model"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	gmhtml "github.com/yuin/goldmark/renderer/html"
	gmtext "github.com/yuin/goldmark/text"
)

var ErrFragmentLimit = errors.New("markdown_fragment_exceeds_limit")

// Length measures the destination's unit, including both UTF-16 surrogate units.
func Length(s string, unit model.LengthUnit) int {
	if unit == model.UTF8 {
		return len(s)
	}
	n := 0
	for _, r := range s {
		n++
		if unit == model.UTF16 && r > 0xffff {
			n++
		}
	}
	return n
}

// Truncate keeps a complete Unicode prefix within the destination's length unit.
func Truncate(s string, maximum int, unit model.LengthUnit) string {
	used := 0
	for offset, r := range s {
		size := Length(string(r), unit)
		if used+size > maximum {
			return s[:offset]
		}
		used += size
	}
	return s
}

func SplitMarkdown(s string, max int, unit model.LengthUnit) ([]string, error) {
	return SplitByRendered(s, max, unit, func(s string) string { return s })
}

// SplitByRendered counts the final platform representation. The renderer must
// be deterministic; every emitted fragment is checked after closing its markup.
func SplitByRendered(s string, max int, unit model.LengthUnit, render func(string) string) ([]string, error) {
	if max < 1 || (unit != model.UTF8 && unit != model.UTF16 && unit != model.Codepoint) || render == nil {
		return nil, errors.New("invalid_markdown_limit")
	}
	if !utf8.ValidString(s) {
		return nil, errors.New("malformed_markdown_unicode")
	}
	fits := func(s string) bool { return Length(render(s), unit) <= max }
	if fits(s) {
		return []string{s}, nil
	}
	source := []byte(s)
	parser := goldmark.New(goldmark.WithExtensions(extension.GFM))
	document := parser.Parser().Parse(gmtext.NewReader(source))
	return children(document, source, fits, "\n\n", 0)
}

type fitsFunc func(string) bool

func pack(parts []string, fits fitsFunc, separator string) ([]string, error) {
	var out []string
	pending := ""
	for _, part := range parts {
		if !fits(part) {
			return nil, ErrFragmentLimit
		}
		joined := part
		if pending != "" {
			joined = pending + separator + part
		}
		if pending != "" && !fits(joined) {
			out = append(out, pending)
			pending = part
		} else {
			pending = joined
		}
	}
	if pending != "" {
		out = append(out, pending)
	}
	return out, nil
}

func scalarParts(s string, wrap func(string) string, fits fitsFunc) ([]string, error) {
	runes := []rune(s)
	if len(runes) == 0 {
		if !fits(wrap("")) {
			return nil, ErrFragmentLimit
		}
		return []string{wrap("")}, nil
	}
	var out []string
	for offset := 0; offset < len(runes); {
		remaining := len(runes) - offset
		high, count := 1, 0
		accepts := func(n int) bool { return fits(wrap(string(runes[offset : offset+n]))) }
		for accepts(high) {
			count = high
			if high == remaining {
				break
			}
			high = min(remaining, high*2)
		}
		if count < remaining {
			low := count + 1
			high--
			for low <= high {
				middle := low + (high-low)/2
				if accepts(middle) {
					count = middle
					low = middle + 1
				} else {
					high = middle - 1
				}
			}
		}
		if count == 0 {
			return nil, ErrFragmentLimit
		}
		out = append(out, wrap(string(runes[offset:offset+count])))
		offset += count
	}
	return out, nil
}

func escape(s string) string {
	var out strings.Builder
	for _, r := range s {
		if strings.ContainsRune("\\`*_{}[]()#+.!>~|=-&", r) {
			out.WriteByte('\\')
		}
		out.WriteRune(r)
	}
	return out.String()
}

func decoded(value []byte) string {
	var buffer bytes.Buffer
	writer := bufio.NewWriter(&buffer)
	gmhtml.DefaultWriter.Write(writer, value)
	_ = writer.Flush()
	return html.UnescapeString(buffer.String())
}

func backticks(s string, minimum int) string {
	longest, current := minimum-1, 0
	for _, r := range s {
		if r == '`' {
			current++
			longest = max(longest, current)
		} else {
			current = 0
		}
	}
	return strings.Repeat("`", longest+1)
}

func codeSpan(s string) string {
	marker := backticks(s, 1)
	pad := ""
	if strings.HasPrefix(s, "`") || strings.HasSuffix(s, "`") || (strings.HasPrefix(s, " ") && strings.HasSuffix(s, " ") && strings.TrimSpace(s) != "") {
		pad = " "
	}
	return marker + pad + s + pad + marker
}

func codeFence(s, language string) string {
	marker := backticks(s, 3)
	language = strings.NewReplacer("`", "", "\r", "", "\n", "").Replace(language)
	return marker + language + "\n" + s + "\n" + marker
}

func children(n ast.Node, source []byte, fits fitsFunc, separator string, depth int) ([]string, error) {
	if depth > 64 {
		return nil, errors.New("markdown_nesting_too_deep")
	}
	var parts []string
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		fragments, err := nodeParts(child, source, fits, depth+1)
		if err != nil {
			return nil, err
		}
		parts = append(parts, fragments...)
	}
	return pack(parts, fits, separator)
}

func wrapped(n ast.Node, source []byte, fits fitsFunc, wrap func(string) string, separator string, depth int) ([]string, error) {
	parts, err := children(n, source, func(s string) bool { return fits(wrap(s)) }, separator, depth)
	if err != nil {
		return nil, err
	}
	for i := range parts {
		parts[i] = wrap(parts[i])
	}
	return parts, nil
}

func nodeParts(n ast.Node, source []byte, fits fitsFunc, depth int) ([]string, error) {
	switch value := n.(type) {
	case *ast.Text:
		s := decoded(value.Value(source))
		if value.HardLineBreak() {
			s += "  \n"
		} else if value.SoftLineBreak() {
			s += "\n"
		}
		return scalarParts(s, escape, fits)
	case *ast.String:
		return scalarParts(decoded(value.Value), escape, fits)
	case *ast.Emphasis:
		marker := strings.Repeat("*", value.Level)
		return wrapped(n, source, fits, func(s string) string {
			trimmed := strings.TrimSpace(s)
			if trimmed == "" {
				return s
			}
			start := strings.Index(s, trimmed)
			return s[:start] + marker + trimmed + marker + s[start+len(trimmed):]
		}, "", depth)
	case *extast.Strikethrough:
		return wrapped(n, source, fits, func(s string) string { return "~~" + s + "~~" }, "", depth)
	case *ast.Link:
		return linkParts(n, source, fits, "[", value.Destination, depth)
	case *ast.Image:
		return linkParts(n, source, fits, "![", value.Destination, depth)
	case *ast.AutoLink:
		return scalarParts(string(value.Label(source)), func(s string) string { return "[" + escape(s) + "](<" + string(value.URL(source)) + ">)" }, fits)
	case *ast.CodeSpan:
		return scalarParts(strings.ReplaceAll(string(nodeText(value, source)), "\n", " "), codeSpan, fits)
	}
	return blockParts(n, source, fits, depth)
}

func blockParts(n ast.Node, source []byte, fits fitsFunc, depth int) ([]string, error) {
	switch value := n.(type) {
	case *ast.FencedCodeBlock:
		return scalarParts(strings.TrimSuffix(string(value.Lines().Value(source)), "\n"), func(s string) string { return codeFence(s, string(value.Language(source))) }, fits)
	case *ast.CodeBlock:
		return scalarParts(strings.TrimSuffix(string(value.Lines().Value(source)), "\n"), func(s string) string { return codeFence(s, "") }, fits)
	case *ast.Heading:
		prefix := strings.Repeat("#", value.Level) + " "
		return wrapped(n, source, fits, func(s string) string { return prefix + s }, "", depth)
	case *ast.Blockquote:
		return wrapped(n, source, fits, func(s string) string { return "> " + strings.ReplaceAll(s, "\n", "\n> ") }, "\n\n", depth)
	case *ast.List:
		return listParts(value, source, fits, depth)
	case *extast.TaskCheckBox:
		if value.IsChecked {
			return []string{"[x] "}, nil
		}
		return []string{"[ ] "}, nil
	case *extast.Table:
		return tableParts(value, source, fits, depth)
	case *ast.ThematicBreak:
		return []string{"---"}, nil
	case *ast.RawHTML:
		return scalarParts(string(value.Segments.Value(source)), escape, fits)
	case *ast.HTMLBlock:
		s := string(value.Lines().Value(source))
		if value.HasClosure() {
			s += string(value.ClosureLine.Value(source))
		}
		return scalarParts(s, escape, fits)
	}
	return children(n, source, fits, "", depth)
}

func linkParts(n ast.Node, source []byte, fits fitsFunc, prefix string, destination []byte, depth int) ([]string, error) {
	href := strings.NewReplacer("<", "%3C", ">", "%3E", "\n", "%0A").Replace(decoded(destination))
	wrap := func(s string) string { return prefix + s + "](<" + href + ">)" }
	if n.FirstChild() == nil {
		label := href
		if prefix == "![" {
			label = "Image"
		}
		return scalarParts(label, func(s string) string { return wrap(escape(s)) }, fits)
	}
	return wrapped(n, source, fits, wrap, "", depth)
}

func listParts(n *ast.List, source []byte, fits fitsFunc, depth int) ([]string, error) {
	var parts []string
	number := n.Start
	for item := n.FirstChild(); item != nil; item = item.NextSibling() {
		prefix := "- "
		if n.IsOrdered() {
			prefix = fmt.Sprintf("%d. ", number)
			number++
		}
		indent := strings.Repeat(" ", len(prefix))
		fragments, err := wrapped(item, source, fits, func(s string) string { return prefix + strings.ReplaceAll(s, "\n", "\n"+indent) }, "\n\n", depth)
		if err != nil {
			return nil, err
		}
		parts = append(parts, fragments...)
	}
	return pack(parts, fits, "\n")
}

func tableParts(n *extast.Table, source []byte, fits fitsFunc, depth int) ([]string, error) {
	row := func(node ast.Node) (string, error) {
		var cells []string
		for cell := node.FirstChild(); cell != nil; cell = cell.NextSibling() {
			parts, err := children(cell, source, func(string) bool { return true }, "", depth)
			if err != nil {
				return "", err
			}
			cells = append(cells, strings.Join(parts, ""))
		}
		return "| " + strings.Join(cells, " | ") + " |", nil
	}
	header, err := row(n.FirstChild())
	if err != nil {
		return nil, err
	}
	var align []string
	for _, value := range n.Alignments {
		switch value {
		case extast.AlignCenter:
			align = append(align, ":---:")
		case extast.AlignRight:
			align = append(align, "---:")
		default:
			align = append(align, "---")
		}
	}
	header += "\n| " + strings.Join(align, " | ") + " |"
	if !fits(header) {
		return nil, errors.New("markdown_table_header_exceeds_limit")
	}
	var out []string
	pending := header
	for child := n.FirstChild().NextSibling(); child != nil; child = child.NextSibling() {
		line, err := row(child)
		if err != nil {
			return nil, err
		}
		if !fits(header + "\n" + line) {
			return nil, errors.New("markdown_table_row_exceeds_limit")
		}
		if !fits(pending + "\n" + line) {
			out = append(out, pending)
			pending = header
		}
		pending += "\n" + line
	}
	return append(out, pending), nil
}
