package config_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/config"
)

// Durations must remain positive after conversion to nanoseconds. Ordinary
// configuration fixtures exercise small values and missed conversion overflow,
// including retention cutoffs that become future dates. Literal limits below
// exercise the public decoder without a clock or other production-only seam.
func TestDecodeRejectsOverflowingRuntimeDurations(t *testing.T) {
	for _, row := range []struct{ section, field, largest, overflow string }{
		{"http", "readTimeoutSeconds", "9223372036", "9223372037"},
		{"http", "writeTimeoutSeconds", "9223372036", "9223372037"},
		{"queue", "pollIntervalMs", "9223372036854", "9223372036855"},
		{"queue", "leaseSeconds", "9223372036", "9223372037"},
		{"queue", "sendLeaseSeconds", "9223372036", "9223372037"},
		{"queue", "retentionDays", "106751", "106752"},
	} {
		t.Run(row.field, func(t *testing.T) {
			input := func(value string) []byte {
				return []byte(strings.Replace(validConfig, `"storage":`, `"`+row.section+`":{"`+row.field+`":`+value+`},"storage":`, 1))
			}
			if _, err := config.Decode(input(row.largest)); err != nil {
				t.Fatalf("representable duration rejected: %v", err)
			}
			_, err := config.Decode(input(row.overflow))
			var field *config.FieldError
			if !errors.As(err, &field) || field.Field != row.section || field.Code != "invalid_limits" {
				t.Fatalf("overflowing duration accepted or misclassified: %v", err)
			}
		})
	}
}
