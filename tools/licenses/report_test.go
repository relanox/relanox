package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The distributed CSV must be identical on Windows and Linux. go-licenses 2.0.1
// Library.FileURL uses filepath.Rel without converting its nested path to URL
// separators; source.Info.FileURL then uses path.Join. These captured upstream
// package/license records previously produced four differing Windows URLs.
// Verified source: github.com/google/go-licenses v2.0.1 licenses/library.go
// and internal/third_party/pkgsite/source/source.go; fixtures are the original
// Windows report and an independently generated Linux report using Go 1.26.0.
// Existing archive tests do not inspect the report's host-dependent contents.
// This exercises production CSV merging/writing, without a test-only seam.
func TestReportCanonicalizesCollectorURLsBeforeDeduplication(t *testing.T) {
	windows := []byte("github.com/stretchr/testify/internal/difflib,https://github.com/stretchr/testify/blob/v1.12.1/internal\\difflib\\LICENSE,BSD-3-Clause\n" +
		"github.com/stretchr/testify/internal/spew,https://github.com/stretchr/testify/blob/v1.12.1/internal\\spew\\LICENSE,ISC\n")
	linux := []byte("github.com/stretchr/testify/internal/difflib,https://github.com/stretchr/testify/blob/v1.12.1/internal/difflib/LICENSE,BSD-3-Clause\n" +
		"github.com/stretchr/testify/internal/spew,https://github.com/stretchr/testify/blob/v1.12.1/internal/spew/LICENSE,ISC\n")
	// A genuinely distinct license or upstream revision must remain visible.
	distinct := []byte("github.com/stretchr/testify/internal/spew,https://github.com/stretchr/testify/blob/v1.12.1/internal/spew/LICENSE,MIT\n" +
		"github.com/stretchr/testify/internal/spew,https://github.com/stretchr/testify/blob/v1.12.2/internal/spew/LICENSE,ISC\n")
	reports := map[string][]string{}
	for _, input := range [][]byte{windows, linux, distinct} {
		if err := mergeReport(input, reports); err != nil {
			t.Fatal(err)
		}
	}
	directory := t.TempDir()
	if err := writeReport(directory, reports); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(directory, "report.csv"))
	if err != nil {
		t.Fatal(err)
	}
	want := "package,license_url,license\n" +
		"github.com/stretchr/testify/internal/difflib,https://github.com/stretchr/testify/blob/v1.12.1/internal/difflib/LICENSE,BSD-3-Clause\n" +
		"github.com/stretchr/testify/internal/spew,https://github.com/stretchr/testify/blob/v1.12.1/internal/spew/LICENSE,ISC\n" +
		"github.com/stretchr/testify/internal/spew,https://github.com/stretchr/testify/blob/v1.12.1/internal/spew/LICENSE,MIT\n" +
		"github.com/stretchr/testify/internal/spew,https://github.com/stretchr/testify/blob/v1.12.2/internal/spew/LICENSE,ISC\n"
	if string(data) != want {
		t.Fatalf("nonportable license report:\n%s", data)
	}
}
