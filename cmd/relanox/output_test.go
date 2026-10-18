package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A script must receive the command's selected JSON format on failures too.
// In-process CLI tests return an error and cannot verify executable stderr.
func TestOperationalFailuresDefaultToJSON(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	directory := t.TempDir()
	binary := buildCLI(t, ctx, directory)
	status := []string{"status", "--config", filepath.Join(directory, "missing.json")}
	for _, row := range []struct {
		name, code string
		args       []string
		json       bool
	}{
		{name: "default", args: status, code: "config: unreadable", json: true},
		{name: "text", args: append(status, "--json=false"), code: "config: unreadable"},
		{name: "explicit", args: append(status, "--json"), code: "config: unreadable", json: true},
		{name: "unknown-command", args: []string{"--json", "unknown-command"}, code: "invalid_command", json: true},
		{name: "unknown-command-text", args: []string{"unknown-command", "--json=false"}, code: "invalid_command"},
	} {
		t.Run(row.name, func(t *testing.T) {
			output, err := exec.CommandContext(ctx, binary, row.args...).CombinedOutput()
			if err == nil {
				t.Fatal("invalid command succeeded")
			}
			if row.json {
				var result struct {
					OK        bool
					ErrorCode string
				}
				if err := json.Unmarshal(output, &result); err != nil || result.OK || result.ErrorCode != row.code {
					t.Fatalf("JSON failure = %q %v", output, err)
				}
			} else if !strings.HasPrefix(string(output), "relanox: "+row.code) {
				t.Fatalf("text failure = %q", output)
			}
		})
	}
}
