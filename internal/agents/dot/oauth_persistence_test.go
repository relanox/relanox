package dot

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
	"github.com/relanox/relanox/internal/transport"
)

// Real SQLite + HTTPS OAuth flows protect one-use authorization codes, PKCE,
// resource/endpoint scoping, refresh-family replay revocation and reopen. A CAS
// regression or omitted family lookup would admit old credentials. Crypto-only
// and guard tests cannot catch durable grant behavior. No core behavior is
// mocked: message operations panic and state uses the production SQLite store.
func TestOAuthCodeAndRotatingRefreshSurviveReopen(t *testing.T) {
	h := newOAuthHarness(t)
	clientID, code := h.authorize(t)
	form := h.codeForm(clientID, code)
	wrong := cloneValues(form)
	wrong.Set("code_verifier", strings.Repeat("x", 43))
	if status, _ := h.form(t, "/agents/dot/oauth/endpoint-A/token", wrong, ""); status != 400 {
		t.Fatal("accepted wrong PKCE verifier")
	}
	status, body := h.form(t, "/agents/dot/oauth/endpoint-A/token", form, "")
	if status != 200 {
		t.Fatalf("code exchange %d %s", status, body)
	}
	tokens := decodeTokens(t, body)
	if tokens.Scope != "offline_access relanox" || tokens.ExpiresIn != 3600 || len(tokens.Access) != 43 || len(tokens.Refresh) != 43 {
		t.Fatalf("invalid token response %s", body)
	}
	if status, _ = h.form(t, "/agents/dot/oauth/endpoint-A/token", form, ""); status != 400 {
		t.Fatal("authorization code reused")
	}
	if status = h.discover(t, "endpoint-A", tokens.Access); status != 200 {
		t.Fatal("access token rejected", status)
	}
	if status = h.discover(t, "endpoint-B", tokens.Access); status != 401 {
		t.Fatal("access escaped endpoint", status)
	}
	refresh := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "resource": {h.origin + "/agents/dot/mcp/endpoint-A"}, "refresh_token": {tokens.Refresh}}
	status, body = h.form(t, "/agents/dot/oauth/endpoint-A/token", refresh, "")
	if status != 200 {
		t.Fatalf("refresh exchange %d %s", status, body)
	}
	next := decodeTokens(t, body)
	if next.Refresh == tokens.Refresh {
		t.Fatal("refresh token did not rotate")
	}
	h.reopen(t)
	if status = h.discover(t, "endpoint-A", next.Access); status != 200 {
		t.Fatal("access token lost across reopen", status)
	}
	status, body = h.form(t, "/agents/dot/oauth/endpoint-A/token", refresh, "")
	if status != 400 {
		t.Fatalf("reused refresh accepted %d %s", status, body)
	}
	h.reopen(t)
	if status = h.discover(t, "endpoint-A", next.Access); status != 401 {
		t.Fatal("refresh replay failed to revoke successor access", status)
	}
	if status = h.discover(t, "endpoint-A", tokens.Access); status != 401 {
		t.Fatal("refresh replay failed to revoke earlier access", status)
	}
	refresh.Set("refresh_token", next.Refresh)
	if status, _ = h.form(t, "/agents/dot/oauth/endpoint-A/token", refresh, ""); status != 400 {
		t.Fatal("revoked family refreshed")
	}
}

func TestOAuthRejectsConsentForgeryAndStopsIssuingAfterSecretRotation(t *testing.T) {
	h := newOAuthHarness(t)
	clientID, pending := h.begin(t)
	finish := url.Values{"request": {pending}, "password": {h.password}, "decision": {"allow"}}
	if status, _ := h.form(t, "/agents/dot/oauth/endpoint-A/authorize", finish, "https://foreign.example"); status != 403 {
		t.Fatal("accepted forged consent origin")
	}
	status, body := h.form(t, "/agents/dot/oauth/endpoint-A/authorize", finish, h.origin)
	if status != 303 {
		t.Fatalf("valid consent %d %s", status, body)
	}
	issuedClient, code := h.authorize(t)
	status, body = h.form(t, "/agents/dot/oauth/endpoint-A/token", h.codeForm(issuedClient, code), "")
	if status != 200 {
		t.Fatalf("initial access %d %s", status, body)
	}
	access := decodeTokens(t, body).Access
	if status = h.discover(t, "endpoint-A", access); status != 200 {
		t.Fatal("initial access rejected")
	}
	t.Setenv("DOT_OAUTH_PASSWORD", strings.Repeat("rotated-password-", 3))
	register := `{"redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"]}`
	if status, _ = h.json(t, "/agents/dot/oauth/endpoint-A/register", register); status != 503 {
		t.Fatal("old-key server still registers clients")
	}
	if status, _ = h.form(t, "/agents/dot/oauth/endpoint-A/token", url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "resource": {h.origin + "/agents/dot/mcp/endpoint-A"}, "refresh_token": {"invalid"}}, ""); status != 503 {
		t.Fatal("old-key server still issues tokens")
	}
	if status = h.discover(t, "endpoint-A", access); status != 401 {
		t.Fatal("rotated server admitted old credentials")
	}
}

type tokenResponse struct {
	Access    string `json:"access_token"`
	Refresh   string `json:"refresh_token"`
	Scope     string `json:"scope"`
	ExpiresIn int    `json:"expires_in"`
}

func decodeTokens(t *testing.T, data []byte) tokenResponse {
	t.Helper()
	var value tokenResponse
	if json.Unmarshal(data, &value) != nil || value.Access == "" || value.Refresh == "" {
		t.Fatalf("invalid tokens %s", data)
	}
	return value
}

type oauthHarness struct {
	origin, password, path string
	server                 *httptest.Server
	client                 *http.Client
	active                 atomic.Pointer[http.ServeMux]
	store                  *storage.Store
	agents                 map[string]*Agent
	callbackClient         *http.Client
	secretEnv              string
}

func newOAuthHarness(t *testing.T) *oauthHarness {
	t.Helper()
	h := &oauthHarness{password: strings.Repeat("owner-password-", 3), path: filepath.Join(t.TempDir(), "oauth.sqlite"), secretEnv: "DOT_OAUTH_PASSWORD"}
	t.Setenv("DOT_OAUTH_PASSWORD", h.password)
	h.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.active.Load().ServeHTTP(w, r) }))
	h.origin = h.server.URL
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	h.client = &http.Client{Transport: h.server.Client().Transport, Jar: jar, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	h.reopen(t)
	t.Cleanup(func() { h.server.Close(); _ = h.store.Close() })
	return h
}

func (h *oauthHarness) reopen(t *testing.T) {
	t.Helper()
	if h.store != nil {
		if err := h.store.Close(); err != nil {
			t.Fatal(err)
		}
	}
	store, err := storage.Open(context.Background(), config.Storage{Driver: "sqlite", Path: h.path}, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.store = store
	mux := http.NewServeMux()
	host := &oauthProtocolHost{origin: h.origin, mux: mux, state: store.State(model.StateNamespace{Component: "agent-dot", OwnerID: "dot"})}
	h.agents = make(map[string]*Agent)
	for _, id := range []string{"endpoint-A", "endpoint-B"} {
		encoded, marshalErr := json.Marshal(Config{MCP: agentmcp.Config{Token: model.SecretRef{Env: h.secretEnv}}})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		endpoint := model.EndpointConfig{ID: id, Agent: model.Dot, Config: encoded}
		agent, constructErr := New(endpoint, agentmcp.Dependencies{Host: host, HTTPClient: h.callbackClient})
		if constructErr != nil {
			t.Fatal(constructErr)
		}
		h.agents[id] = agent
	}
	h.active.Store(mux)
}

func (h *oauthHarness) json(t *testing.T, path, body string) (int, []byte) {
	t.Helper()
	request, err := http.NewRequest("POST", h.origin+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	return h.do(t, request)
}

func (h *oauthHarness) form(t *testing.T, path string, form url.Values, origin string) (int, []byte) {
	t.Helper()
	request, err := http.NewRequest("POST", h.origin+path, strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	return h.do(t, request)
}

func (h *oauthHarness) do(t *testing.T, request *http.Request) (int, []byte) {
	t.Helper()
	response, err := h.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, body
}

var pendingInput = regexp.MustCompile(`name="request" value="([A-Za-z0-9_-]+)"`)

func (h *oauthHarness) begin(t *testing.T) (clientID, pending string) {
	t.Helper()
	return h.beginScope(t, "relanox offline_access")
}

func (h *oauthHarness) beginScope(t *testing.T, scope string) (clientID, pending string) {
	t.Helper()
	status, data := h.json(t, "/agents/dot/oauth/endpoint-A/register", `{"client_name":"ChatGPT","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"]}`)
	if status != 201 {
		t.Fatalf("registration %d %s", status, data)
	}
	var client oauthClient
	if json.Unmarshal(data, &client) != nil || client.ClientID == "" {
		t.Fatal("missing client ID")
	}
	// RFC7636 section B's independent PKCE challenge/verifier vector:
	// https://www.rfc-editor.org/rfc/rfc7636#appendix-B
	query := url.Values{"response_type": {"code"}, "client_id": {client.ClientID}, "redirect_uri": {"https://chatgpt.com/connector_platform_oauth_redirect"}, "resource": {h.origin + "/agents/dot/mcp/endpoint-A"}, "scope": {scope}, "code_challenge_method": {"S256"}, "code_challenge": {"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"}, "state": {"native-state"}}
	request, err := http.NewRequest("GET", h.origin+"/agents/dot/oauth/endpoint-A/authorize?"+query.Encode(), nil)
	if err != nil {
		t.Fatal(err)
	}
	status, data = h.do(t, request)
	if status != 200 {
		t.Fatalf("consent %d %s", status, data)
	}
	if strings.Contains(string(data), h.password) {
		t.Fatal("authorization password leaked into consent page")
	}
	match := pendingInput.FindSubmatch(data)
	if len(match) != 2 {
		t.Fatalf("missing pending grant %s", data)
	}
	return client.ClientID, string(match[1])
}

func (h *oauthHarness) authorize(t *testing.T) (clientID, code string) {
	t.Helper()
	return h.authorizeScope(t, "relanox offline_access")
}

func (h *oauthHarness) authorizeScope(t *testing.T, scope string) (clientID, code string) {
	t.Helper()
	clientID, pending := h.beginScope(t, scope)
	request, err := http.NewRequest("POST", h.origin+"/agents/dot/oauth/endpoint-A/authorize", strings.NewReader(url.Values{"request": {pending}, "password": {h.password}, "decision": {"allow"}}.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", h.origin)
	response, err := h.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 303 {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("allow consent %d %s", response.StatusCode, data)
	}
	redirect, err := url.Parse(response.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if redirect.Host != "chatgpt.com" || redirect.Query().Get("state") != "native-state" || redirect.Query().Get("iss") != h.origin+"/agents/dot/oauth/endpoint-A" {
		t.Fatal("invalid authorization redirect")
	}
	code = redirect.Query().Get("code")
	if code == "" {
		t.Fatal("missing authorization code")
	}
	return clientID, code
}

func (h *oauthHarness) codeForm(clientID, code string) url.Values {
	return url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {code}, "redirect_uri": {"https://chatgpt.com/connector_platform_oauth_redirect"}, "resource": {h.origin + "/agents/dot/mcp/endpoint-A"}, "code_verifier": {"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"}}
}

func (h *oauthHarness) discover(t *testing.T, id, token string) int {
	t.Helper()
	request, err := http.NewRequest("POST", h.origin+"/agents/dot/mcp/"+id, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", "2026-07-28")
	request.Header.Set("Mcp-Method", "server/discover")
	status, _ := h.do(t, request)
	return status
}

func cloneValues(in url.Values) url.Values {
	out := url.Values{}
	for k, values := range in {
		out[k] = append([]string{}, values...)
	}
	return out
}

type oauthProtocolHost struct {
	origin string
	mux    *http.ServeMux
	state  model.StateStore
}

func (h *oauthProtocolHost) PublicURL() string { return h.origin }

func (h *oauthProtocolHost) State() model.StateStore { return h.state }

func (h *oauthProtocolHost) Observer() model.Observer { panic("unexpected observer access") }

func (h *oauthProtocolHost) Connection(model.ConnectionStatus, string) {
	panic("unexpected connection access")
}

func (h *oauthProtocolHost) MountHTTP(route model.HTTPRoute) error {
	h.mux.Handle(route.Pattern, transport.RouteHandler(route))
	return nil
}

func (h *oauthProtocolHost) ForPrincipal(context.Context, model.Principal) (model.ScopedAgentHost, error) {
	return unusedMessageScope{}, nil
}

type unusedMessageScope struct{}

func (unusedMessageScope) Media() model.AgentMediaHost { return nil }

func (unusedMessageScope) Status(context.Context, model.StatusInput) (model.AgentStatus, error) {
	panic("unexpected core status access")
}

func (unusedMessageScope) SendMessage(context.Context, model.SendMessageInput) (model.MessageReceipt, error) {
	panic("unexpected core send access")
}

func (unusedMessageScope) ReadMessages(context.Context, model.ReadMessagesInput) ([]model.AgentMessage, error) {
	panic("unexpected core recovery access")
}
