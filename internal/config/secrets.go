package config

import (
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/relanox/relanox/internal/model"
)

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func ValidateSecretRef(ref model.SecretRef, field string) error {
	if ref.Env == "" && ref.File == "" {
		return invalid(field, "secret_reference_required")
	}
	if ref.Env != "" && !envName.MatchString(ref.Env) {
		return invalid(field+".env", "invalid_environment_name")
	}
	if strings.ContainsRune(ref.File, 0) {
		return invalid(field+".file", "invalid_path")
	}
	return nil
}

// ResolveSecret reads a reference at the point of use so credential rotation
// takes effect without embedding secrets in accepted work. File paths resolve
// beside the selected config. Errors contain no reference names or values.
func (c Config) ResolveSecret(ref model.SecretRef) (string, error) {
	if err := ValidateSecretRef(ref, "credential"); err != nil {
		return "", err
	}
	if ref.Env != "" {
		if value := os.Getenv(ref.Env); value != "" {
			return value, nil
		}
	}
	if ref.File == "" {
		return "", invalid("credential", "environment_unset")
	}
	file, err := os.Open(c.ResolvePath(ref.File))
	if err != nil {
		return "", invalid("credential", "file_unreadable")
	}
	// Read errors are handled below; this descriptor carries no pending writes.
	defer func() { _ = file.Close() }()
	const maxSecretBytes = 64 << 10
	data, err := io.ReadAll(io.LimitReader(file, maxSecretBytes+1))
	if err != nil || len(data) > maxSecretBytes {
		return "", invalid("credential", "invalid_file")
	}
	value := strings.TrimRight(string(data), "\r\n")
	if value == "" {
		return "", invalid("credential", "empty")
	}
	return value, nil
}
