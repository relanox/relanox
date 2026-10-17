package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Published bookmarks must reach the current Go topics, while VitePress owns
// its current homepages and content. The old renderer unconditionally replaced
// both language homepages. Real filesystem fixtures exercise emitted artifacts,
// including project-site redirects, without a build-tool or filesystem seam.
func TestPublishedURLsPreserveBuiltPagesAndReachCurrentTopics(t *testing.T) {
	site := t.TempDir()
	out := filepath.Join(t.TempDir(), "project")
	for route, content := range map[string]string{
		"index.html": "VitePress root", "en/index.html": "English VitePress home",
		"zh-CN/index.html": "Chinese VitePress home", "en/connect.html": "Current connection guide",
		"en/quickstart.html": "Current quickstart", "en/channels.html": "Current channels",
		"en/architecture.html": "Current architecture", "assets/theme.css": "VitePress theme",
	} {
		writeFixture(t, site, route, content)
	}
	if err := build(site, out); err != nil {
		t.Fatal(err)
	}
	for route, want := range map[string]string{
		"index.html": "VitePress root", "en/index.html": "English VitePress home",
		"zh-CN/index.html": "Chinese VitePress home", "en/connect.html": "Current connection guide",
	} {
		if got := readFixture(t, site, route); got != want {
			t.Errorf("built page %s was replaced: %s", route, got)
		}
	}
	for route, target := range map[string]string{
		"zh-CN/getting-started.html": "../zh-CN/quickstart.html",
		"en/channels/wechat.html":    "../../en/channels.html",
		"en/reference/core.html":     "../../en/operations.html",
		"zh-CN/reference/sdk.html":   "../../en/architecture.html",
		"zh-CN/architecture.html":    "../en/architecture.html",
		"en/reference/licenses.html": "https://github.com/relanox/relanox/blob/master/licenses/README.md",
	} {
		assertRedirect(t, readFixture(t, site, route), target)
	}
	for _, route := range []string{"index.html", "en/index.html", "zh-CN/index.html", "en/connect.html", "en/quickstart.html", "en/channels/wechat.html", "zh-CN/reference/sdk.html"} {
		assertRedirect(t, readFixture(t, out, route), "https://relanox.github.io/"+route)
	}
	if _, err := os.Stat(filepath.Join(out, "assets", "theme.css")); !os.IsNotExist(err) {
		t.Fatalf("project redirects copied site assets: %v", err)
	}
}

// The optional output path may be inside the built site. A repeated invocation
// must not consume its own project redirects and create project/project URLs.
func TestProjectOutputIsExcludedFromInputOnRepeatedBuild(t *testing.T) {
	site := t.TempDir()
	out := filepath.Join(site, "project")
	writeFixture(t, site, "en/index.html", "VitePress homepage")
	writeFixture(t, out, "stale.html", "Previous project output")
	for range 2 {
		if err := build(site, out); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(out, "project")); !os.IsNotExist(err) {
		t.Fatalf("project output became input: %v", err)
	}
	if got := readFixture(t, site, "en/index.html"); got != "VitePress homepage" {
		t.Fatal("repeated build replaced homepage")
	}
	assertRedirect(t, readFixture(t, out, "en/index.html"), "https://relanox.github.io/en/index.html")
}

// An output directory containing the source could overwrite built pages through
// matching language paths. Reject it before adding aliases or emitting redirects.
func TestOverlappingOutputCannotReplaceBuiltSite(t *testing.T) {
	root := t.TempDir()
	site := filepath.Join(root, "en")
	writeFixture(t, site, "index.html", "Built VitePress page")
	for _, out := range []string{site, root} {
		if err := build(site, out); err == nil {
			t.Fatal("output containing the built site was accepted")
		}
		if got := readFixture(t, site, "index.html"); got != "Built VitePress page" {
			t.Fatal("overlapping output replaced the built page")
		}
	}
}

func writeFixture(t *testing.T, root, route, content string) {
	t.Helper()
	file := filepath.Join(root, filepath.FromSlash(route))
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func readFixture(t *testing.T, root, route string) string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(route)))
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func assertRedirect(t *testing.T, body, target string) {
	t.Helper()
	if !strings.Contains(body, `<link rel="canonical" href="`+target+`">`) || !strings.Contains(body, `location.replace("`+target+`" + location.search + location.hash)`) {
		t.Fatalf("redirect lost destination, query or fragment: %s", body)
	}
}
