package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path"
	"time"
)

func archive(destination, prefix string, entries []entry, windows bool) (result error) {
	file, err := os.Create(destination)
	if err != nil {
		return err
	}
	defer func() {
		result = errors.Join(result, file.Close())
		if result != nil {
			_ = os.Remove(destination)
		}
	}()
	if windows {
		return zipArchive(file, prefix, entries)
	}
	compressed := gzip.NewWriter(file)
	if err = tarArchive(compressed, prefix, entries); err != nil {
		_ = compressed.Close()
		return err
	}
	return compressed.Close()
}

func tarArchive(output io.Writer, prefix string, entries []entry) (result error) {
	writer := tar.NewWriter(output)
	defer func() { result = errors.Join(result, writer.Close()) }()
	for _, file := range entries {
		info, err := os.Stat(file.Path)
		if err != nil {
			return err
		}
		mode := int64(0644)
		if file.Executable {
			mode = 0755
		}
		if err = writer.WriteHeader(&tar.Header{Name: path.Join(prefix, file.Name), Mode: mode, Size: info.Size(), ModTime: time.Unix(0, 0)}); err != nil {
			return err
		}
		if err = copyEntry(writer, file.Path); err != nil {
			return err
		}
	}
	return nil
}

func zipArchive(output io.Writer, prefix string, entries []entry) (result error) {
	writer := zip.NewWriter(output)
	defer func() { result = errors.Join(result, writer.Close()) }()
	for _, file := range entries {
		header := &zip.FileHeader{Name: path.Join(prefix, file.Name), Method: zip.Deflate}
		mode := os.FileMode(0644)
		if file.Executable {
			mode = 0755
		}
		header.SetMode(mode)
		header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
		entry, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		if err = copyEntry(entry, file.Path); err != nil {
			return err
		}
	}
	return nil
}

func copyEntry(output io.Writer, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(output, file)
	return err
}
