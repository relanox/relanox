package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Regenerating after a dependency removal must drop its generated notice and
// -check must report stale bundle contents. Existing report tests only compare
// regenerated files, missing extra notices left in a published bundle. Real
// filesystem publication exercises the existing production boundary; no seam.
func TestPublishRemovesObsoleteGeneratedNotices(t *testing.T) {
	stage, target := t.TempDir(), t.TempDir()
	current := filepath.Join("go", "current", "LICENSE")
	stale := filepath.Join("go", "removed", "LICENSE")
	for path, content := range map[string]string{
		filepath.Join(stage, current):      "current notice",
		filepath.Join(target, current):     "current notice",
		filepath.Join(target, stale):       "obsolete notice",
		filepath.Join(target, "README.md"): "maintained documentation",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := publish(stage, target, true); err == nil {
		t.Error("check accepted obsolete generated notice")
	}
	if got, err := os.ReadFile(filepath.Join(target, stale)); err != nil || string(got) != "obsolete notice" {
		t.Fatalf("check modified the published bundle: %q %v", got, err)
	}
	if err := publish(stage, target, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(target, stale)); !os.IsNotExist(err) {
		t.Errorf("obsolete notice remains: %v", err)
	}
	for relative, want := range map[string]string{current: "current notice", "README.md": "maintained documentation"} {
		got, err := os.ReadFile(filepath.Join(target, relative))
		if err != nil || string(got) != want {
			t.Errorf("publication changed %s: %q %v", relative, got, err)
		}
	}
	if err := publish(stage, target, true); err != nil {
		t.Errorf("regenerated bundle fails check: %v", err)
	}
}
