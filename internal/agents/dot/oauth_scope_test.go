package dot

import (
	"net/url"
	"testing"
)

// RFC6749 section6 permits a subset for an access-token refresh request, while
// requiring a rotated refresh token to retain its predecessor's scope:
// https://www.rfc-editor.org/rfc/rfc6749#section-6
// Existing real SQLite/HTTPS rotation tests omit scope and miss both accidental
// equality-only rejection and narrowing of the durable refresh grant. These use
// the same production routes/state and the existing independent PKCE vector.
func TestOAuthRefreshNarrowsAccessWithoutNarrowingRefreshGrant(t *testing.T) {
	h := newOAuthHarness(t)
	clientID, code := h.authorize(t)
	status, body := h.form(t, "/agents/dot/oauth/endpoint-A/token", h.codeForm(clientID, code), "")
	if status != 200 {
		t.Fatalf("code exchange %d %s", status, body)
	}
	original := decodeTokens(t, body)
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "resource": {h.origin + "/agents/dot/mcp/endpoint-A"}, "refresh_token": {original.Refresh}, "scope": {"relanox"}}
	status, body = h.form(t, "/agents/dot/oauth/endpoint-A/token", form, "")
	if status != 200 {
		t.Fatalf("narrow refresh %d %s", status, body)
	}
	narrowed := decodeTokens(t, body)
	if narrowed.Scope != "relanox" || narrowed.Refresh == original.Refresh {
		t.Fatalf("narrowing/rotation lost: %s", body)
	}
	h.reopen(t)
	if status = h.discover(t, "endpoint-A", narrowed.Access); status != 200 {
		t.Fatal("narrowed access rejected after reopen", status)
	}
	form.Del("scope")
	form.Set("refresh_token", narrowed.Refresh)
	status, body = h.form(t, "/agents/dot/oauth/endpoint-A/token", form, "")
	if status != 200 {
		t.Fatalf("scope omitted after rotation %d %s", status, body)
	}
	if next := decodeTokens(t, body); next.Scope != "offline_access relanox" {
		t.Fatalf("rotated refresh lost original grant scope: %s", body)
	}
}

// An invalid expansion must not rotate or consume the legitimate refresh token.
// A valid subset test alone could pass an implementation accepting all scopes.
func TestOAuthRefreshRejectsScopeExpansionWithoutConsumingGrant(t *testing.T) {
	h := newOAuthHarness(t)
	clientID, code := h.authorizeScope(t, "relanox")
	status, body := h.form(t, "/agents/dot/oauth/endpoint-A/token", h.codeForm(clientID, code), "")
	if status != 200 {
		t.Fatalf("code exchange %d %s", status, body)
	}
	original := decodeTokens(t, body)
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "resource": {h.origin + "/agents/dot/mcp/endpoint-A"}, "refresh_token": {original.Refresh}, "scope": {"relanox offline_access"}}
	status, body = h.form(t, "/agents/dot/oauth/endpoint-A/token", form, "")
	if status != 400 {
		t.Fatalf("expanded refresh accepted %d %s", status, body)
	}
	form.Set("scope", "relanox")
	status, body = h.form(t, "/agents/dot/oauth/endpoint-A/token", form, "")
	if status != 200 {
		t.Fatalf("invalid expansion consumed grant %d %s", status, body)
	}
	if next := decodeTokens(t, body); next.Scope != "relanox" {
		t.Fatalf("expanded scope survived: %s", body)
	}
}
