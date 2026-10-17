// Command docs-redirects preserves published URLs around a built VitePress site.
package main

import (
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const canonicalBase = "https://relanox.github.io/"

func main() {
	site := flag.String("site", "docs/.vitepress/dist", "Built VitePress site directory")
	out := flag.String("out", "docs/.vitepress/redirects", "Project-site redirect directory")
	flag.Parse()
	if err := build(*site, *out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func build(site, out string) error {
	site, err := filepath.Abs(site)
	if err != nil {
		return err
	}
	out, err = filepath.Abs(out)
	if err != nil {
		return err
	}
	if relative, err := filepath.Rel(out, site); err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("redirect_output_must_not_contain_site")
	}
	pages, err := htmlPages(site, out)
	if err != nil {
		return err
	}
	if len(pages) == 0 {
		return fmt.Errorf("no_built_documentation_pages")
	}
	if err := writeLegacyRedirects(site); err != nil {
		return err
	}
	pages, err = htmlPages(site, out)
	if err != nil {
		return err
	}
	for _, page := range pages {
		if err := writeRedirect(out, page, canonicalBase+page); err != nil {
			return err
		}
	}
	return os.WriteFile(filepath.Join(out, ".nojekyll"), nil, 0644)
}

func htmlPages(site, out string) ([]string, error) {
	var pages []string
	err := filepath.WalkDir(site, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if relative, err := filepath.Rel(out, file); err == nil && relative == "." {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(file, ".html") {
			return nil
		}
		relative, err := filepath.Rel(site, file)
		if err != nil {
			return err
		}
		pages = append(pages, filepath.ToSlash(relative))
		return nil
	})
	return pages, err
}
