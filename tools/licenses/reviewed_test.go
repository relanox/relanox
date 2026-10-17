package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// The collector must retain the reviewed MIT-0 notice while refusing changed
// license text or a new, unreviewed module revision. go-licenses v2.0.1 rejected
// asm v1.2.1 as unknown; earlier report/archive tests do not cover this fallback.
// The fixture is the exact upstream LICENSE from segmentio/asm v1.2.1, retrieved
// from https://github.com/segmentio/asm/blob/v1.2.1/LICENSE. Real files exercise the
// production verification and bundling boundary without a test-only seam.
func TestReviewedNoticePreservesUpstreamAndRejectsChanges(t *testing.T) {
	fixture, err := os.ReadFile("testdata/segmentio-MIT-0.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, version string
		changed       bool
		accepted      bool
	}{
		{"reviewed", "v1.2.1", false, true},
		{"changed notice", "v1.2.1", true, false},
		{"unreviewed version", "v1.2.2", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			source, output := t.TempDir(), filepath.Join(t.TempDir(), "bundle")
			data := bytes.Clone(fixture)
			if test.changed {
				data = append(data, []byte("Additional restriction.\n")...)
			}
			if err := os.WriteFile(filepath.Join(source, "LICENSE"), data, 0600); err != nil {
				t.Fatal(err)
			}
			reports := map[string][]string{}
			err := saveReviewedNotice(reviewedModule{"github.com/segmentio/asm", test.version, source}, output, reports)
			if !test.accepted {
				if err == nil || len(reports) != 0 {
					t.Fatalf("unreviewed notice accepted: error=%v reports=%v", err, reports)
				}
				if _, err := os.Stat(output); !os.IsNotExist(err) {
					t.Fatalf("unreviewed notice published: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(filepath.Join(output, "github.com/segmentio/asm/LICENSE"))
			if err != nil || !bytes.Equal(got, fixture) {
				t.Fatalf("upstream notice not preserved: %v", err)
			}
			row := reports["github.com/segmentio/asm\x00https://github.com/segmentio/asm/blob/v1.2.1/LICENSE\x00MIT-0"]
			if len(reports) != 1 || len(row) != 3 || row[2] != "MIT-0" {
				t.Fatalf("missing MIT-0 report: %v", reports)
			}
		})
	}
}
