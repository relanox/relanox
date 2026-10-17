// Command check runs the repository's formatting, analysis and test gates.
package main

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	files, err := goFiles()
	if err != nil {
		fail(err)
	}
	if len(files) > 0 {
		root, err := exec.Command("go", "env", "GOROOT").Output()
		if err != nil {
			fail(err)
		}
		out, err := exec.Command(filepath.Join(strings.TrimSpace(string(root)), "bin", "gofmt"), append([]string{"-l"}, files...)...).CombinedOutput()
		if err != nil {
			fail(fmt.Errorf("gofmt: %s", out))
		}
		if strings.TrimSpace(string(out)) != "" {
			fail(fmt.Errorf("run gofmt on:\n%s", out))
		}
	}
	sources, err := analyzeSources(files)
	if err != nil {
		fail(err)
	}
	if len(sources) > 0 {
		runCommand("go", append([]string{"tool", "github.com/fzipp/gocyclo/cmd/gocyclo", "-over", "20"}, sources...)...)
	}
	runCommand("go", "vet", "./...")
	runLint()
	runCommand("go", "test", "./...")
}

func runLint() {
	version, err := os.ReadFile(".golangci-lint-version")
	if err != nil {
		fail(err)
	}
	want := strings.TrimPrefix(strings.TrimSpace(string(version)), "v")
	tool := "golangci-lint"
	if local, err := exec.LookPath(filepath.Join("bin", tool)); err == nil {
		tool = local
	}
	out, err := exec.Command(tool, "version", "--short").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != want {
		fail(fmt.Errorf("install golangci-lint v%s in bin/ or on PATH: https://golangci-lint.run/docs/welcome/install/local/", want))
	}
	runCommand(tool, "config", "verify")
	runCommand(tool, "run", "./...")
}

func runCommand(name string, args ...string) {
	command := exec.Command(name, args...)
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		fail(err)
	}
}

func goFiles() ([]string, error) {
	var result []string
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && path != "." {
			switch entry.Name() {
			case ".ref", ".worktree", ".research", ".git", "vendor", "node_modules":
				return filepath.SkipDir
			}
		}
		if !entry.IsDir() && strings.HasSuffix(path, ".go") {
			result = append(result, path)
		}
		return nil
	})
	return result, err
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
