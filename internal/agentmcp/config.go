// Package agentmcp implements the authenticated tool and media boundary shared
// by the three native cloud agents. It does not load plugins or extensions.
package agentmcp

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/transport"
)

type Config struct {
	Auth           string          `json:"auth,omitempty"`
	Token          model.SecretRef `json:"token"`
	AllowedOrigins []string        `json:"allowedOrigins,omitempty"`
}

type Dependencies struct {
	Host          model.AgentHost
	ResolveSecret func(model.SecretRef) (string, error)
	ResolvePath   func(string) string
	HTTPClient    *http.Client
}

func (d Dependencies) Secret(ref model.SecretRef) (string, error) {
	if d.ResolveSecret != nil {
		return d.ResolveSecret(ref)
	}
	return (config.Config{}).ResolveSecret(ref)
}

var defaultHTTPClient = transport.NewClient(transport.Options{Timeout: 120 * time.Second})

func (d Dependencies) Client() *http.Client {
	if d.HTTPClient != nil {
		return d.HTTPClient
	}
	return defaultHTTPClient
}

func (c *Config) Validate(allowed ...string) error {
	if c.Auth == "" {
		c.Auth = allowed[0]
	}
	valid := false
	for _, v := range allowed {
		if c.Auth == v {
			valid = true
		}
	}
	if !valid {
		return errors.New("mcp.auth: unsupported_authentication")
	}
	if err := config.ValidateSecretRef(c.Token, "mcp.token"); err != nil {
		return err
	}
	for _, origin := range c.AllowedOrigins {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Scheme != "https" && u.Scheme != "http" {
			return errors.New("mcp.allowedOrigins: invalid_origin")
		}
	}
	return nil
}

func Decode(data json.RawMessage, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		return errors.New("invalid_configuration")
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		return errors.New("invalid_configuration")
	}
	return nil
}

func EqualSecret(a, b string) bool { return hmac.Equal([]byte(a), []byte(b)) }

func Opaque() string {
	var data [32]byte
	if _, err := rand.Read(data[:]); err != nil {
		panic("secure_random_unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(data[:])
}

func UUID() string {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		panic("secure_random_unavailable")
	}
	data[6] = data[6]&15 | 64
	data[8] = data[8]&63 | 128
	return hexGroup(data[:4]) + "-" + hexGroup(data[4:6]) + "-" + hexGroup(data[6:8]) + "-" + hexGroup(data[8:10]) + "-" + hexGroup(data[10:])
}

func hexGroup(data []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, len(data)*2)
	for i, b := range data {
		out[i*2] = digits[b>>4]
		out[i*2+1] = digits[b&15]
	}
	return string(out)
}

func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func ID(value string) bool {
	return len(value) > 0 && len(value) <= 1024 && !strings.ContainsRune(value, 0)
}
