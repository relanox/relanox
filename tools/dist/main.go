// Command dist builds a portable binary archive with documentation and licenses.
package main

import (
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

type entry struct {
	Name       string
	Path       string
	Executable bool
}

func main() {
	targetOS := flag.String("os", "", "linux, darwin or windows")
	arch := flag.String("arch", "", "amd64 or arm64")
	version := flag.String("version", "dev", "Version embedded in the executable")
	out := flag.String("out", "dist", "Archive directory")
	flag.Parse()
	if err := build(*targetOS, *arch, *version, *out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func build(targetOS, arch, version, out string) error {
	if !supportedTarget(targetOS, arch) || !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`).MatchString(version) {
		return fmt.Errorf("invalid_distribution_target_or_version")
	}
	if _, err := os.Stat("licenses/go"); err != nil {
		return fmt.Errorf("generate_dependency_licenses_first")
	}
	temporary, err := os.MkdirTemp("", "relanox-build-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(temporary) }() // Best-effort cleanup after the build.
	name := "relanox"
	extension := ".tar.gz"
	if targetOS == "windows" {
		name += ".exe"
		extension = ".zip"
	}
	binary := filepath.Join(temporary, name)
	defer func() { _ = os.Remove(binary) }()
	command := exec.Command("go", "build", "-trimpath", "-ldflags", "-s -w -X main.version="+version, "-o", binary, "./cmd/relanox")
	command.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+targetOS, "GOARCH="+arch)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err = command.Run(); err != nil {
		return fmt.Errorf("binary_build_failed: %w", err)
	}
	entries := []entry{{Name: name, Path: binary, Executable: true}}
	for _, file := range []string{"LICENSE", "README.md", "README.zh-CN.md"} {
		entries = append(entries, entry{Name: file, Path: file})
	}
	for _, directory := range []string{"licenses", "docs"} {
		files, err := collect(directory)
		if err != nil {
			return err
		}
		entries = append(entries, files...)
	}
	if err = os.MkdirAll(out, 0755); err != nil {
		return err
	}
	stem := "relanox_" + version + "_" + targetOS + "_" + arch
	path := filepath.Join(out, stem+extension)
	if err = archive(path, stem, entries, targetOS == "windows"); err != nil {
		return err
	}
	fmt.Println(path)
	return nil
}

func supportedTarget(targetOS, arch string) bool {
	return (targetOS == "linux" || targetOS == "darwin" || targetOS == "windows") && (arch == "amd64" || arch == "arm64")
}

func collect(directory string) ([]entry, error) {
	var result []entry
	err := filepath.WalkDir(directory, func(path string, file fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if file.IsDir() {
			if file.Name() == "site" || file.Name() == "local" || strings.HasPrefix(file.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if file.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("distribution_source_symlink_forbidden")
		}
		if directory == "docs" && !strings.HasSuffix(path, ".md") {
			return nil
		}
		result = append(result, entry{Name: filepath.ToSlash(path), Path: path})
		return nil
	})
	return result, err
}
