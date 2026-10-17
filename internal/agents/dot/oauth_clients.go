package dot

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
)

type oauthClient struct {
	ClientID      string   `json:"client_id,omitempty"`
	ClientName    string   `json:"client_name"`
	RedirectURIs  []string `json:"redirect_uris"`
	AuthMethod    string   `json:"token_endpoint_auth_method"`
	GrantTypes    []string `json:"grant_types"`
	ResponseTypes []string `json:"response_types"`
}

type clientRegistration struct {
	Metadata  oauthClient `json:"metadata"`
	ExpiresAt int64       `json:"expiresAt"`
}

type clientRegistry struct{ secret, resource string }

func (c clientRegistry) sign(payload string) string {
	h := hmac.New(sha256.New, []byte(c.secret))
	_, _ = h.Write([]byte("relanox-oauth-client:" + c.resource + ":" + payload))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

var connectorRedirect = regexp.MustCompile(`^/connector/oauth/[A-Za-z0-9_-]+$`)

func nativeRedirect(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Host == "chatgpt.com" && u.User == nil && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && (u.Path == "/connector_platform_oauth_redirect" || connectorRedirect.MatchString(u.Path))
}

func (c clientRegistry) register(metadata oauthClient) (oauthClient, error) {
	if metadata.ClientName == "" {
		metadata.ClientName = "ChatGPT"
	}
	if metadata.AuthMethod == "" {
		metadata.AuthMethod = "none"
	}
	if metadata.GrantTypes == nil {
		metadata.GrantTypes = []string{"authorization_code", "refresh_token"}
	}
	if metadata.ResponseTypes == nil {
		metadata.ResponseTypes = []string{"code"}
	}
	if len(metadata.ClientName) > 100 || metadata.AuthMethod != "none" || len(metadata.RedirectURIs) < 1 || len(metadata.RedirectURIs) > 10 || len(metadata.ResponseTypes) != 1 || metadata.ResponseTypes[0] != "code" || len(metadata.GrantTypes) < 1 || len(metadata.GrantTypes) > 2 || !slices.Contains(metadata.GrantTypes, "authorization_code") {
		return oauthClient{}, oauthFailure("invalid_client_metadata")
	}
	for _, grant := range metadata.GrantTypes {
		if grant != "authorization_code" && grant != "refresh_token" {
			return oauthClient{}, oauthFailure("invalid_client_metadata")
		}
	}
	for _, redirect := range metadata.RedirectURIs {
		if !nativeRedirect(redirect) {
			return oauthClient{}, oauthFailure("invalid_client_metadata")
		}
	}
	metadata.ClientID = ""
	data, err := json.Marshal(clientRegistration{Metadata: metadata, ExpiresAt: time.Now().Add(clientLifetime).UnixMilli()})
	if err != nil {
		return oauthClient{}, err
	}
	payload := base64.RawURLEncoding.EncodeToString(data)
	if len(payload) > 1800 {
		return oauthClient{}, oauthFailure("invalid_client_metadata")
	}
	metadata.ClientID = payload + "." + c.sign(payload)
	return metadata, nil
}

func (c clientRegistry) resolve(id string) (oauthClient, error) {
	parts := strings.Split(id, ".")
	if len(parts) != 2 || parts[0] == "" || len(parts[0]) > 1800 || !agentmcp.EqualSecret(c.sign(parts[0]), parts[1]) {
		return oauthClient{}, oauthError{"invalid_client", 401}
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	var registration clientRegistration
	if err != nil || json.Unmarshal(data, &registration) != nil || registration.ExpiresAt <= time.Now().UnixMilli() {
		return oauthClient{}, oauthError{"invalid_client", 401}
	}
	metadata := registration.Metadata
	metadata.ClientID = id
	return metadata, nil
}

func requestedScope(value string) (string, error) {
	if value == "" {
		value = "relanox"
	}
	seen := map[string]bool{}
	for _, scope := range strings.Fields(value) {
		if scope != "relanox" && scope != "offline_access" {
			return "", oauthFailure("invalid_scope")
		}
		seen[scope] = true
	}
	if !seen["relanox"] {
		return "", oauthFailure("invalid_scope")
	}
	items := make([]string, 0, len(seen))
	for item := range seen {
		items = append(items, item)
	}
	sort.Strings(items)
	return strings.Join(items, " "), nil
}

func singleParameters(values url.Values) error {
	for _, v := range values {
		if len(v) != 1 {
			return oauthFailure("invalid_request")
		}
	}
	return nil
}
