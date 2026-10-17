package config

import (
	"net"
	"net/url"
	"strconv"
	"strings"
)

// ValidatePublicURL accepts a configured deployment origin. HTTP is allowed
// only for loopback IP literals during local development; paths are forbidden.
func ValidatePublicURL(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery || (u.Path != "" && u.Path != "/") || u.RawPath != "" || strings.ContainsAny(value, "\\?# \t\r\n") || !validOriginPort(u) {
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

func validOriginPort(u *url.URL) bool {
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if u.Port() == "" {
		return true
	}
	port, err := strconv.Atoi(u.Port())
	return err == nil && port > 0 && port <= 65535
}
