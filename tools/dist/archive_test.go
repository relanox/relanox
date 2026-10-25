package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// Published archives must include their executable and actual project license bytes
// under a portable prefix. A build-only check misses empty/truncated archives or
// stripped Unix execute bits. This exercises real archive formats and files,
// with no production-only seam or expected values derived by the packager.
func TestDistributionArchivesContainExecutableAndLicense(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "binary")
	license := filepath.Join(directory, "license")
	if err := os.WriteFile(binary, []byte("compiled executable"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(license, []byte("license notice"), 0600); err != nil {
		t.Fatal(err)
	}
	entries := []entry{{Name: "relanox", Path: binary, Executable: true}, {Name: "LICENSE", Path: license}}
	for _, windows := range []bool{false, true} {
		path := filepath.Join(directory, "archive")
		if err := archive(path, "release", entries, windows); err != nil {
			t.Fatal(err)
		}
		var contents map[string]string
		if windows {
			contents = readZip(t, path)
		} else {
			contents = readTar(t, path)
		}
		if len(contents) != 2 || contents["release/relanox"] != "compiled executable" || contents["release/LICENSE"] != "license notice" {
			t.Fatalf("invalid distribution content: %#v", contents)
		}
	}
}

func readZip(t *testing.T, path string) map[string]string {
	t.Helper()
	reader, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reader.Close() }()
	result := map[string]string{}
	for _, file := range reader.File {
		if file.Name == "release/relanox" && file.Mode().Perm() != 0755 {
			t.Fatal("archive lost executable mode")
		}
		stream, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(stream)
		_ = stream.Close()
		if err != nil {
			t.Fatal(err)
		}
		result[file.Name] = string(data)
	}
	return result
}

func readTar(t *testing.T, path string) map[string]string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = compressed.Close() }()
	reader := tar.NewReader(compressed)
	result := map[string]string{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Name == "release/relanox" && header.Mode != 0755 {
			t.Fatal("archive lost executable mode")
		}
		data, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		result[header.Name] = string(data)
	}
	return result
}
