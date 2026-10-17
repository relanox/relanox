package googlechat

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"golang.org/x/oauth2/jwt"
)

// Google SDK JSON and OAuth responses are bounded before its decoders see them.
// Media downloads use a streaming limit at the attachment boundary instead.
type boundedTransport struct{ base http.RoundTripper }

func (t boundedTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func (t boundedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	response, err := base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(request.URL.Path, "/v1/media/") && response.StatusCode >= 200 && response.StatusCode < 300 {
		return response, nil
	}
	defer func() { _ = response.Body.Close() }()
	maximum := int64(1 << 20)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		maximum = 64 << 10
	}
	raw, err := common.ReadBounded(response.Body, maximum)
	if err != nil {
		return nil, errors.New("native_invalid_response")
	}
	response.Body = io.NopCloser(bytes.NewReader(raw))
	response.ContentLength = int64(len(raw))
	return response, nil
}

func (c *Channel) credentials() (*jwt.Config, string, error) {
	raw, err := c.options.Secret(c.config.ServiceAccount)
	if err != nil || len(raw) > 64<<10 {
		return nil, "", errors.New("oauth_unavailable")
	}
	var document struct {
		Type string `json:"type"`
	}
	if json.Unmarshal([]byte(raw), &document) != nil || document.Type != "service_account" {
		return nil, "", errors.New("oauth_unavailable")
	}
	credentials, err := google.JWTConfigFromJSON([]byte(raw), "https://www.googleapis.com/auth/chat.bot")
	if err != nil || !strings.Contains(credentials.Email, "@") || len(credentials.PrivateKey) > 16<<10 {
		return nil, "", errors.New("oauth_unavailable")
	}
	// A service-account document cannot redirect signed assertions or credentials.
	credentials.TokenURL = "https://oauth2.googleapis.com/token"
	return credentials, raw, nil
}

func (c *Channel) accessToken(ctx context.Context) (string, error) {
	credentials, identity, err := c.credentials()
	if err != nil {
		return "", err
	}
	return c.tokens.Get(ctx, identity, func(ctx context.Context) (string, time.Time, error) {
		ctx = context.WithValue(ctx, oauth2.HTTPClient, c.client)
		token, err := credentials.TokenSource(ctx).Token()
		if err != nil || token.AccessToken == "" {
			return "", time.Time{}, errors.New("oauth_unavailable")
		}
		return token.AccessToken, token.Expiry.Add(-30 * time.Second), nil
	})
}

func (c *Channel) authorize(request *http.Request) error {
	value, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
	if !ok || len(value) > 32<<10 {
		return errors.New("unauthorized")
	}
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return errors.New("unauthorized")
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	var fields struct {
		Alg string `json:"alg"`
	}
	if err != nil || json.Unmarshal(header, &fields) != nil || fields.Alg != "RS256" {
		return errors.New("unauthorized")
	}
	payload, err := c.validator.Validate(request.Context(), value, c.audience)
	if err != nil {
		return errors.New("unauthorized")
	}
	verified, _ := payload.Claims["email_verified"].(bool)
	email, _ := payload.Claims["email"].(string)
	now := time.Now().Unix()
	if (payload.Issuer != "accounts.google.com" && payload.Issuer != "https://accounts.google.com") || email != "chat@system.gserviceaccount.com" || !verified || payload.Expires <= now || payload.IssuedAt <= 0 || payload.IssuedAt > now+60 || payload.Expires <= payload.IssuedAt {
		return errors.New("unauthorized")
	}
	return nil
}
