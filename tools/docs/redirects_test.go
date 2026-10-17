package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Existing bookmarks must reach current content after the renderer migration.
// These are published URLs from the previous VitePress site, not routes derived
// from the renderer. No network service or production-only seam is required.
func TestPublishedDocumentationRedirects(t *testing.T) {
	for _, base := range []string{"", "https://relanox.github.io/"} {
		t.Run(base, func(t *testing.T) {
			out := t.TempDir()
			if err := build("../../docs", out, base); err != nil {
				t.Fatal(err)
			}
			for _, route := range []struct{ alias, relative, target string }{
				{"en/index.html", "../en/quickstart.html", "en/quickstart.html"},
				{"zh-CN/index.html", "../zh-CN/quickstart.html", "zh-CN/quickstart.html"},
				{"zh-CN/getting-started.html", "../zh-CN/quickstart.html", "zh-CN/quickstart.html"},
				{"en/channels/wechat.html", "../../en/channels.html", "en/channels.html"},
				{"zh-CN/reference/sdk.html", "../../en/architecture.html", "en/architecture.html"},
			} {
				want := route.relative
				if base != "" {
					want = base + route.target
				}
				body, err := os.ReadFile(filepath.Join(out, filepath.FromSlash(route.alias)))
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(string(body), `<link rel="canonical" href="`+want+`">`) {
					t.Errorf("%s does not redirect to %s", route.alias, want)
				}
			}
		})
	}
}

func TestProjectDocumentationRedirect(t *testing.T) {
	out := t.TempDir()
	if err := build("../../docs", out, "https://relanox.github.io/"); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(out, "en", "quickstart.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `location.replace("https://relanox.github.io/en/quickstart.html" + location.search + location.hash)`) {
		t.Fatalf("project redirect must retain the query and fragment: %s", body)
	}
}
