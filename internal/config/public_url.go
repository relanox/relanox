package config

import (
	"net"
	"net/url"
	"strings"
)

// ValidatePublicURL accepts a configured deployment origin. HTTP is allowed
// only for loopback IP literals during local development; paths are forbidden.
func ValidatePublicURL(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery || (u.Path != "" && u.Path != "/") || u.RawPath != "" || strings.ContainsAny(value, "\\?# \t\r\n") {
		return "", invalid("http.publicUrl", "invalid_origin")
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || ip == nil || !ip.IsLoopback() {
			return "", invalid("http.publicUrl", "https_required")
		}
	}
	return u.Scheme + "://" + u.Host, nil
}
