package config

import (
	"net/url"
	"strconv"
	"strings"
)

// ValidateObservability accepts an explicit administrator-owned collector URL;
// private/local HTTP collectors are supported without weakening media policy.
func ValidateObservability(observability Observability) error {
	switch observability.Level {
	case "", "debug", "info", "warn", "error":
	default:
		return invalid("observability.level", "invalid_level")
	}
	if observability.OTLPEndpoint == "" {
		return nil
	}
	u, err := url.Parse(observability.OTLPEndpoint)
	if err != nil || len(observability.OTLPEndpoint) > 4096 || u.Opaque != "" || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || strings.HasSuffix(u.Host, ":") || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(observability.OTLPEndpoint, "#") {
		return invalid("observability.otlpEndpoint", "invalid_collector_url")
	}
	if port := u.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			return invalid("observability.otlpEndpoint", "invalid_collector_url")
		}
	}
	return nil
}
