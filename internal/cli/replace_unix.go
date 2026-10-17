//go:build !windows

package cli

import "os"

func replaceFile(source, target string) error { return os.Rename(source, target) }
