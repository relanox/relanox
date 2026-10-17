// Command check runs the repository's formatting, analysis and test gates.
package main

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func main() {
	files, err := goFiles()
	if err != nil {
		fail(err)
	}
	if len(files) > 0 {
		out, err := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "gofmt"), append([]string{"-l"}, files...)...).CombinedOutput()
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
		runGo(append([]string{"tool", "github.com/fzipp/gocyclo/cmd/gocyclo", "-over", "20"}, sources...)...)
	}
	runGo("vet", "./...")
	runGo("test", "./...")
}

func runGo(args ...string) {
	command := exec.Command("go", args...)
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
