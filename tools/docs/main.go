// Command docs renders Markdown documentation and validates local links.
package main

import (
	"bytes"
	_ "embed"
	"flag"
	"fmt"
	"html/template"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

//go:embed style.css
var stylesheet string

type page struct {
	Path     string
	Source   string
	Title    string
	Language string
	HTML     template.HTML
}
type navigation struct {
	Title string
	URL   string
}
type view struct {
	Page          page
	Root          string
	Navigation    []navigation
	OtherLanguage string
	OtherLabel    string
}

func main() {
	source := flag.String("source", "docs", "Markdown source directory")
	out := flag.String("out", "docs/site", "Output directory")
	flag.Parse()
	if err := build(*source, *out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func build(source, out string) error {
	pages, err := readPages(source)
	if err != nil {
		return err
	}
	if len(pages) == 0 {
		return fmt.Errorf("no_documentation_pages")
	}
	if err = os.MkdirAll(out, 0755); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(out, "style.css"), []byte(stylesheet), 0644); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(out, ".nojekyll"), nil, 0644); err != nil {
		return err
	}
	for _, current := range pages {
		if err = writePage(out, current, pages); err != nil {
			return err
		}
	}
	fmt.Printf("Built %d documentation pages in %s\n", len(pages), out)
	return nil
}

func readPages(source string) ([]page, error) {
	var pages []page
	err := filepath.WalkDir(source, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "site" || entry.Name() == "local" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(file, ".md") {
			return nil
		}
		relative, err := filepath.Rel(source, file)
		if err != nil {
			return err
		}
		current, err := renderPage(source, filepath.ToSlash(relative))
		if err != nil {
			return err
		}
		pages = append(pages, current)
		return nil
	})
	sort.Slice(pages, func(i, j int) bool { return pages[i].Path < pages[j].Path })
	return pages, err
}

func renderPage(source, relative string) (page, error) {
	data, err := os.ReadFile(filepath.Join(source, filepath.FromSlash(relative)))
	if err != nil {
		return page{}, err
	}
	markdown := goldmark.New(goldmark.WithExtensions(extension.GFM), goldmark.WithParserOptions(parser.WithAutoHeadingID()))
	document := markdown.Parser().Parse(text.NewReader(data), parser.WithContext(parser.NewContext(parser.WithIDs(&headingIDs{used: map[string]bool{}}))))
	if err = rewriteLinks(document, source, relative); err != nil {
		return page{}, err
	}
	var rendered bytes.Buffer
	if err = markdown.Renderer().Render(&rendered, data, document); err != nil {
		return page{}, err
	}
	title := strings.TrimSuffix(path.Base(relative), ".md")
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "# ") {
			title = strings.TrimSpace(strings.TrimPrefix(line, "# "))
			break
		}
	}
	language := "en"
	if strings.HasPrefix(relative, "zh-CN/") {
		language = "zh-CN"
	}
	return page{Path: strings.TrimSuffix(relative, ".md") + ".html", Source: relative, Title: title, Language: language, HTML: template.HTML(rendered.String())}, nil
}

func rewriteLinks(document ast.Node, source, relative string) error {
	return ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		link, ok := node.(*ast.Link)
		if !ok {
			return ast.WalkContinue, nil
		}
		destination, err := localDestination(source, relative, string(link.Destination))
		if err != nil {
			return ast.WalkStop, err
		}
		link.Destination = []byte(destination)
		return ast.WalkContinue, nil
	})
}

func localDestination(source, relative, destination string) (string, error) {
	if strings.Contains(destination, ":") || strings.HasPrefix(destination, "#") || strings.HasPrefix(destination, "//") {
		return destination, nil
	}
	target, fragment, _ := strings.Cut(destination, "#")
	if !strings.HasSuffix(target, ".md") {
		return destination, nil
	}
	resolved := filepath.Clean(filepath.Join(source, filepath.FromSlash(path.Dir(relative)), filepath.FromSlash(target)))
	if _, err := os.Stat(resolved); err != nil {
		return "", fmt.Errorf("%s: broken documentation link %s", relative, destination)
	}
	if fragment != "" {
		if err := validateAnchor(resolved, fragment); err != nil {
			return "", fmt.Errorf("%s: broken heading link %s", relative, destination)
		}
	}
	inside, err := filepath.Rel(source, resolved)
	if err != nil {
		return "", err
	}
	if inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		repository, err := filepath.Rel(filepath.Dir(source), resolved)
		if err != nil {
			return "", err
		}
		return "https://github.com/relanox/relanox/blob/master/" + filepath.ToSlash(repository), nil
	}
	result := strings.TrimSuffix(target, ".md") + ".html"
	if fragment != "" {
		result += "#" + fragment
	}
	return result, nil
}

type headingIDs struct{ used map[string]bool }

func (ids *headingIDs) Generate(value []byte, _ ast.NodeKind) []byte {
	var slug strings.Builder
	for _, r := range string(value) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			slug.WriteRune(unicode.ToLower(r))
		case unicode.IsSpace(r) || r == '-' || r == '_':
			slug.WriteByte('-')
		}
	}
	base := strings.Trim(slug.String(), "-")
	if base == "" {
		base = "heading"
	}
	result := base
	for n := 1; ids.used[result]; n++ {
		result = fmt.Sprintf("%s-%d", base, n)
	}
	ids.used[result] = true
	return []byte(result)
}

func (ids *headingIDs) Put(value []byte) { ids.used[string(value)] = true }

func validateAnchor(file, fragment string) error {
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	markdown := goldmark.New(goldmark.WithExtensions(extension.GFM), goldmark.WithParserOptions(parser.WithAutoHeadingID()))
	document := markdown.Parser().Parse(text.NewReader(data), parser.WithContext(parser.NewContext(parser.WithIDs(&headingIDs{used: map[string]bool{}}))))
	found := false
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if value, ok := node.AttributeString("id"); ok {
				if id, ok := value.([]byte); ok && string(id) == fragment {
					found = true
					return ast.WalkStop, nil
				}
			}
		}
		return ast.WalkContinue, nil
	})
	if !found {
		return fmt.Errorf("heading_not_found")
	}
	return nil
}

func writePage(out string, current page, pages []page) error {
	root := strings.Repeat("../", strings.Count(current.Path, "/"))
	data := view{Page: current, Root: root, OtherLanguage: root + "zh-CN/quickstart.html", OtherLabel: "简体中文"}
	if current.Language == "zh-CN" {
		data.OtherLanguage = root + "en/quickstart.html"
		data.OtherLabel = "English"
	}
	for _, candidate := range pages {
		if strings.HasPrefix(candidate.Path, current.Language+"/") {
			data.Navigation = append(data.Navigation, navigation{Title: candidate.Title, URL: root + candidate.Path})
		}
	}
	var body bytes.Buffer
	if err := layout.Execute(&body, data); err != nil {
		return err
	}
	target := filepath.Join(out, filepath.FromSlash(current.Path))
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	return os.WriteFile(target, body.Bytes(), 0644)
}

var layout = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="{{.Page.Language}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>{{.Page.Title}} · Relanox</title><link rel="stylesheet" href="{{.Root}}style.css"></head>
<body><header><a class="brand" href="{{.Root}}index.html">Relanox</a><nav aria-label="Project"><a href="{{.OtherLanguage}}">{{.OtherLabel}}</a><a href="https://github.com/relanox/relanox">GitHub</a></nav></header>
<div class="layout"><aside><nav aria-label="Documentation">{{range .Navigation}}<a href="{{.URL}}">{{.Title}}</a>{{end}}</nav></aside><main id="content">{{.Page.HTML}}<footer><a href="https://github.com/relanox/relanox/blob/master/docs/{{.Page.Source}}">Relanox documentation</a> · MIT</footer></main></div></body></html>`))
