package dot

import (
	"encoding/json"
	"net/url"
	"testing"
)

// Registered grant_types declares which grants the client is authorized to use:
// https://www.rfc-editor.org/rfc/rfc7591#section-2
// https://www.rfc-editor.org/rfc/rfc6749#section-5.2
// Existing OAuth flows omit grant_types and always receive Relanox's established
// code+refresh default. They miss explicit code-only registration. This runs the
// real registration/consent/token routes with SQLite, not a mocked grant engine.
func TestOAuthExplicitCodeOnlyClientDoesNotReceiveRefreshToken(t *testing.T) {
	h := newOAuthHarness(t)
	clientID, code := h.authorizeClientScope(t, "relanox", `{"client_name":"ChatGPT","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"grant_types":["authorization_code"]}`)
	status, body := h.form(t, "/agents/dot/oauth/endpoint-A/token", h.codeForm(clientID, code), "")
	if status != 200 {
		t.Fatalf("code exchange %d %s", status, body)
	}
	var response map[string]json.RawMessage
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	if _, ok := response["refresh_token"]; ok {
		t.Fatalf("code-only client received refresh credential: %s", body)
	}
	var tokens tokenResponse
	if err := json.Unmarshal(body, &tokens); err != nil || tokens.Access == "" {
		t.Fatalf("missing access token: %s", body)
	}
	if tokens.Access == "" || tokens.Scope != "relanox" {
		t.Fatalf("missing ordinary access: %s", body)
	}
	h.reopen(t)
	if status = h.discover(t, "endpoint-A", tokens.Access); status != 200 {
		t.Fatal("code-only access lost across reopen", status)
	}
}

func TestOAuthExplicitCodeOnlyClientCannotUseRefreshGrant(t *testing.T) {
	h := newOAuthHarness(t)
	clientID, code := h.authorizeClientScope(t, "relanox", `{"client_name":"ChatGPT","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"grant_types":["authorization_code"]}`)
	status, body := h.form(t, "/agents/dot/oauth/endpoint-A/token", h.codeForm(clientID, code), "")
	if status != 200 {
		t.Fatalf("code exchange %d %s", status, body)
	}
	// A previously issued refresh credential must also be refused if its client
	// metadata explicitly excludes refresh. Baseline currently issues one here;
	// after the fix, any credential still must fail at grant authorization first.
	var tokens tokenResponse
	if err := json.Unmarshal(body, &tokens); err != nil || tokens.Access == "" {
		t.Fatalf("missing access token: %s", body)
	}
	token := tokens.Refresh
	if token == "" {
		token = "not-authorized"
	}
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "resource": {h.origin + "/agents/dot/mcp/endpoint-A"}, "refresh_token": {token}}
	status, body = h.form(t, "/agents/dot/oauth/endpoint-A/token", form, "")
	var failure struct {
		Error string `json:"error"`
	}
	if status != 400 || json.Unmarshal(body, &failure) != nil || failure.Error != "unauthorized_client" {
		t.Fatalf("client used unregistered grant: %d %s", status, body)
	}
}
