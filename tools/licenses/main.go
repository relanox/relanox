// Command licenses collects notices and required sources for every binary target.
package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

const licenseTool = "github.com/google/go-licenses/v2@v2.0.1"

var targets = []string{"darwin/amd64", "darwin/arm64", "linux/amd64", "linux/arm64", "windows/amd64", "windows/arm64"}

type module struct {
	Path    string
	Version string
	Sum     string
	Main    bool `json:",omitempty"`
}

type manifest struct {
	GoVersion string   `json:"goVersion"`
	Collector string   `json:"collector"`
	Targets   []string `json:"targets"`
	Modules   []module `json:"modules"`
}

func main() {
	check := flag.Bool("check", false, "Regenerate and compare the committed bundle")
	flag.Parse()
	if err := generate(*check); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func generate(check bool) error {
	temporary, err := os.MkdirTemp("", "relanox-licenses-*")
	if err != nil {
		return err
	}
	defer removeTemporary(temporary)
	raw := filepath.Join(temporary, "raw")
	modules := map[string]module{}
	reports := map[string][]string{}
	for i, target := range targets {
		if err = collectTarget(temporary, raw, target, i, modules, reports); err != nil {
			return err
		}
	}
	stage := filepath.Join(temporary, "bundle")
	if err = writeBundle(stage, raw, modules, reports); err != nil {
		return err
	}
	return publish(stage, "licenses", check)
}

// The temporary root is created by this command. Verify its resolved boundary
// before recursive cleanup on Windows or Unix; never remove an output directory.
func removeTemporary(directory string) {
	root, err := filepath.Abs(os.TempDir())
	if err != nil {
		return
	}
	path, err := filepath.Abs(directory)
	if err != nil || filepath.Dir(path) != root || !strings.HasPrefix(filepath.Base(path), "relanox-licenses-") {
		return
	}
	_ = os.RemoveAll(path)
}

func goCommand(target string, args ...string) ([]byte, error) {
	command := exec.Command("go", args...)
	parts := strings.Split(target, "/")
	command.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+parts[0], "GOARCH="+parts[1])
	var stderr bytes.Buffer
	command.Stderr = &stderr
	data, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("license_collection_failed_for_%s: %w\n%s", target, err, stderr.String())
	}
	return data, nil
}

func collectTarget(temporary, raw, target string, index int, modules map[string]module, reports map[string][]string) error {
	fmt.Fprintln(os.Stderr, "Collecting licenses for", target)
	destination := filepath.Join(temporary, fmt.Sprintf("target-%d", index))
	// Build the collector for the host, then inspect packages for the target.
	tool, err := collector(temporary)
	if err != nil {
		return err
	}
	command := exec.Command(tool, "save", "./cmd/relanox", "--save_path", destination, "--ignore", "github.com/relanox/relanox")
	parts := strings.Split(target, "/")
	command.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+parts[0], "GOARCH="+parts[1])
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("license_scan_%s: %w\n%s", target, err, output)
	}
	reportCommand := exec.Command(tool, "report", "./cmd/relanox", "--ignore", "github.com/relanox/relanox")
	reportCommand.Env = command.Env
	var diagnostic bytes.Buffer
	reportCommand.Stderr = &diagnostic
	report, err := reportCommand.Output()
	if err != nil {
		return fmt.Errorf("license_report_%s: %w\n%s", target, err, diagnostic.String())
	}
	if err = mergeReport(report, reports); err != nil {
		return err
	}
	if err = mergeFiles(destination, raw); err != nil {
		return err
	}
	data, err := goCommand(target, "list", "-deps", "-json", "./cmd/relanox")
	if err != nil {
		return err
	}
	return decodeModules(data, modules)
}

func mergeReport(data []byte, reports map[string][]string) error {
	rows, err := csv.NewReader(bytes.NewReader(data)).ReadAll()
	if err != nil {
		return err
	}
	for _, row := range rows {
		if len(row) != 3 {
			return fmt.Errorf("invalid_license_report_columns")
		}
		// go-licenses v2.0.1 Library.FileURL passes filepath.Rel to the
		// URL builder. On Windows, nested LICENSE paths retain backslashes.
		// URLs use slash separators regardless of the collector's host OS.
		row[1] = strings.ReplaceAll(row[1], "\\", "/")
		reports[strings.Join(row, "\x00")] = row
	}
	return nil
}

func collector(temporary string) (string, error) {
	name := "go-licenses"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(temporary, name)
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	command := exec.Command("go", "install", licenseTool)
	command.Env = append(os.Environ(), "GOBIN="+temporary, "GOOS="+runtime.GOOS, "GOARCH="+runtime.GOARCH)
	if output, err := command.CombinedOutput(); err != nil {
		return "", fmt.Errorf("build_license_collector: %w\n%s", err, output)
	}
	return path, nil
}

func decodeModules(data []byte, modules map[string]module) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	for {
		var pkg struct{ Module *module }
		if err := decoder.Decode(&pkg); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if pkg.Module != nil && !pkg.Module.Main {
			modules[pkg.Module.Path] = *pkg.Module
		}
	}
}

func writeBundle(stage, raw string, modules map[string]module, reports map[string][]string) error {
	if err := os.MkdirAll(stage, 0755); err != nil {
		return err
	}
	if err := copyNotices(raw, filepath.Join(stage, "go")); err != nil {
		return err
	}
	if err := writeReport(stage, reports); err != nil {
		return err
	}
	if err := sourceArchive(filepath.Join(stage, "source-notices.tar.gz"), raw); err != nil {
		return err
	}
	if err := copyNotice(filepath.Join(runtime.GOROOT(), "LICENSE"), filepath.Join(stage, "go-standard-library", "LICENSE")); err != nil {
		return err
	}
	for _, port := range []string{"internal/musewire", "internal/channels/qq", "internal/channels/dingtalk"} {
		if err := copyPort(stage, port); err != nil {
			return err
		}
	}
	if err := enrichModules(modules); err != nil {
		return err
	}
	entries := make([]module, 0, len(modules))
	for _, item := range modules {
		entries = append(entries, item)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	data, err := json.MarshalIndent(manifest{GoVersion: runtime.Version(), Collector: licenseTool, Targets: targets, Modules: entries}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(stage, "modules.json"), append(data, '\n'), 0644)
}

func enrichModules(modules map[string]module) error {
	data, err := exec.Command("go", "list", "-m", "-json", "all").Output()
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	for {
		var item module
		if err = decoder.Decode(&item); err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
		if _, exists := modules[item.Path]; exists {
			if item.Sum == "" {
				return fmt.Errorf("missing_dependency_checksum: %s", item.Path)
			}
			modules[item.Path] = item
		}
	}
}

func writeReport(stage string, reports map[string][]string) error {
	keys := make([]string, 0, len(reports))
	for key := range reports {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var data bytes.Buffer
	writer := csv.NewWriter(&data)
	if err := writer.Write([]string{"package", "license_url", "license"}); err != nil {
		return err
	}
	for _, key := range keys {
		if err := writer.Write(reports[key]); err != nil {
			return err
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(stage, "report.csv"), data.Bytes(), 0644)
}
