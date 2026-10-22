// Package transport supplies bounded, context-aware native HTTP transport.
package transport

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var (
	ErrUnsafeURL        = errors.New("unsafe_remote_url")
	ErrResponseTooLarge = errors.New("response_too_large")
	ErrInvalidResponse  = errors.New("invalid_remote_response")
)

type Options struct {
	Timeout      time.Duration
	MaxRedirects int
	// Administrator-supplied trust roots and client certificates for enterprise
	// endpoints. The configuration is cloned; DNS/dial policy stays enforced.
	TLSClientConfig *tls.Config
	// AllowedHosts, when present, restricts all initial and redirect destinations.
	AllowedHosts []string
	// Private destinations require an explicit host allowlist, for example a
	// configured local Signal bridge. Never derive it from untrusted media URLs.
	AllowPrivateHosts []string
}

func NewClient(options Options) *http.Client {
	if options.Timeout <= 0 {
		options.Timeout = 30 * time.Second
	}
	if options.MaxRedirects <= 0 {
		options.MaxRedirects = 5
	}
	policy := hostPolicy{allowed: hostSet(options.AllowedHosts), private: hostSet(options.AllowPrivateHosts)}
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	base := &http.Transport{
		// Environment proxies would bypass destination-address verification.
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return policy.dial(ctx, dialer, network, address)
		},
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           100,
		IdleConnTimeout:        90 * time.Second,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  options.Timeout,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: 1 << 20,
	}
	if options.TLSClientConfig != nil {
		base.TLSClientConfig = options.TLSClientConfig.Clone()
	}
	return &http.Client{
		Timeout:   options.Timeout,
		Transport: &checkedTransport{base: base, policy: policy},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= options.MaxRedirects {
				return errors.New("too_many_redirects")
			}
			if err := policy.checkURL(req.URL); err != nil {
				return err
			}
			if len(via) > 0 && !sameOrigin(req.URL, via[0].URL) {
				return errors.New("cross_origin_redirect")
			}
			return nil
		},
	}
}

type checkedTransport struct {
	base   *http.Transport
	policy hostPolicy
}

func (t *checkedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := t.policy.checkURL(req.URL); err != nil {
		return nil, err
	}
	return t.base.RoundTrip(req)
}

func (t *checkedTransport) CloseIdleConnections() { t.base.CloseIdleConnections() }

type hostPolicy struct{ allowed, private map[string]bool }

func hostSet(hosts []string) map[string]bool {
	result := make(map[string]bool, len(hosts))
	for _, host := range hosts {
		result[strings.ToLower(strings.TrimSuffix(host, "."))] = true
	}
	return result
}

func (p hostPolicy) checkURL(u *url.URL) error {
	if u == nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return ErrUnsafeURL
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if len(p.allowed) > 0 && !p.allowed[host] {
		return ErrUnsafeURL
	}
	if u.Scheme == "http" && !p.private[host] {
		return ErrUnsafeURL
	}
	if address, err := netip.ParseAddr(host); err == nil && !publicIP(address) && !p.private[host] {
		return ErrUnsafeURL
	}
	return nil
}

func (p hostPolicy) dial(ctx context.Context, dialer *net.Dialer, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, ErrUnsafeURL
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if len(p.allowed) > 0 && !p.allowed[host] {
		return nil, ErrUnsafeURL
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, errors.New("remote_resolution_failed")
	}
	if len(addresses) == 0 {
		return nil, errors.New("remote_resolution_failed")
	}
	// Reject the complete DNS result if any answer is private. Dial the checked
	// literal directly, preventing a second resolution and DNS rebinding.
	for _, ip := range addresses {
		if !p.private[host] && !publicIP(ip) {
			return nil, ErrUnsafeURL
		}
	}
	var last error
	for _, ip := range addresses {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		last = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, fmt.Errorf("remote_connection_failed: %w", last)
}

var reserved = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("100:0:0:1::/64"),
	netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("5f00::/16"),
}

func publicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.Zone() != "" {
		return false
	}
	for _, prefix := range reserved {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

func sameOrigin(a, b *url.URL) bool { return a.Scheme == b.Scheme && strings.EqualFold(a.Host, b.Host) }

// HTTPError contains no remote body, URL, credentials or response headers.
type HTTPError struct {
	Status     int
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string { return "remote_http_status_" + strconv.Itoa(e.Status) }

func RetryAfter(header string, now time.Time) time.Duration {
	if seconds, err := strconv.ParseInt(header, 10, 32); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if date, err := http.ParseTime(header); err == nil && date.After(now) {
		return date.Sub(now)
	}
	return 0
}

func ReadBody(body io.Reader, maxBytes int64) ([]byte, error) {
	if maxBytes < 1 {
		return nil, ErrResponseTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrResponseTooLarge
	}
	return data, nil
}

func DoJSON(ctx context.Context, client *http.Client, method, endpoint string, headers http.Header, input, output any, maxBytes int64) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return errors.New("invalid_request_json")
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return ErrUnsafeURL
	}
	req.Header = headers.Clone()
	if req.Header == nil {
		req.Header = make(http.Header)
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, ErrUnsafeURL) {
			return ErrUnsafeURL
		}
		return errors.New("remote_request_failed")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &HTTPError{Status: response.StatusCode, RetryAfter: RetryAfter(response.Header.Get("Retry-After"), time.Now())}
	}
	data, err := ReadBody(response.Body, maxBytes)
	if err != nil {
		return err
	}
	if output == nil || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, output); err != nil {
		return ErrInvalidResponse
	}
	return nil
}
