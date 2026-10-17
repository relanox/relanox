package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func walkFiles(root string, visit func(string, string) error) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("license_source_symlink_forbidden")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		return visit(path, relative)
	})
}

func mergeFiles(source, destination string) error {
	return walkFiles(source, func(path, relative string) error {
		target := filepath.Join(destination, relative)
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		prior, err := os.ReadFile(target)
		if err == nil && !bytes.Equal(prior, data) {
			return fmt.Errorf("conflicting_license_sources: %s", relative)
		}
		return copyFile(path, target)
	})
}

func copyFile(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	return os.WriteFile(target, data, 0644)
}

// Readable notices use repository line endings. The complete source archive
// separately preserves every upstream byte, including original line endings.
func copyNotice(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	return os.WriteFile(target, bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n")), 0644)
}

func noticeName(name string) bool {
	name = strings.ToUpper(name)
	for _, prefix := range []string{"LICENSE", "LICENCE", "COPYING", "COPYRIGHT", "NOTICE", "AUTHORS"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func copyNotices(raw, target string) error {
	return walkFiles(raw, func(path, relative string) error {
		if !noticeName(filepath.Base(path)) {
			return nil
		}
		return copyNotice(path, filepath.Join(target, relative))
	})
}

func copyPort(stage, directory string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !noticeName(entry.Name()) {
			continue
		}
		if err = copyNotice(filepath.Join(directory, entry.Name()), filepath.Join(stage, "ports", directory, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func sourceArchive(path, raw string) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	zipped := gzip.NewWriter(file)
	archive := tar.NewWriter(zipped)
	err = walkFiles(raw, func(path, relative string) error {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		header := &tar.Header{Name: filepath.ToSlash(relative), Mode: 0644, Size: int64(len(data)), ModTime: time.Unix(0, 0)}
		if err = archive.WriteHeader(header); err != nil {
			return err
		}
		_, err = archive.Write(data)
		return err
	})
	for _, close := range []func() error{archive.Close, zipped.Close, file.Close} {
		if closeErr := close(); err == nil {
			err = closeErr
		}
	}
	return err
}

func publish(stage, target string, check bool) error {
	return walkFiles(stage, func(path, relative string) error {
		destination := filepath.Join(target, relative)
		if check {
			want, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			got, err := os.ReadFile(destination)
			if err != nil || !bytes.Equal(want, got) {
				return fmt.Errorf("license_bundle_outdated: %s", relative)
			}
			return nil
		}
		return copyFile(path, destination)
	})
}
