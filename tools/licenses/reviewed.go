package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// go-licenses v2.0.1 does not classify MIT-0. This exact upstream revision and
// notice were reviewed at https://github.com/segmentio/asm/blob/v1.2.1/LICENSE.
// Verify the module and complete notice before excluding it from the classifier;
// retain its original bytes in the bundle and its SPDX identity in the report.
// A different revision or license must be reviewed again, never silently skipped.
const collectorIgnored = "github.com/relanox/relanox,github.com/segmentio/asm/"

type reviewedModule struct {
	Path    string
	Version string
	Dir     string
}

func collectReviewedNotice(target, raw string, reports map[string][]string) error {
	data, err := goCommand(target, "list", "-m", "-json", "github.com/segmentio/asm")
	if err != nil {
		return err
	}
	var selected reviewedModule
	if err := json.Unmarshal(data, &selected); err != nil {
		return err
	}
	return saveReviewedNotice(selected, raw, reports)
}

func saveReviewedNotice(selected reviewedModule, raw string, reports map[string][]string) error {
	if selected.Path != "github.com/segmentio/asm" || selected.Version != "v1.2.1" || selected.Dir == "" {
		return fmt.Errorf("unreviewed_dependency_license_revision")
	}
	source := filepath.Join(selected.Dir, "LICENSE")
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if fmt.Sprintf("%x", sha256.Sum256(data)) != "cca993712df289a5958bdef69031a5dac0f951ac15afeb313f9eeea55ed59443" {
		return fmt.Errorf("reviewed_dependency_license_changed")
	}
	if err := copyFile(source, filepath.Join(raw, selected.Path, "LICENSE")); err != nil {
		return err
	}
	row := []string{selected.Path, "https://github.com/segmentio/asm/blob/v1.2.1/LICENSE", "MIT-0"}
	reports[strings.Join(row, "\x00")] = row
	return nil
}
