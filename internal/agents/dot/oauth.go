package dot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

type grant struct {
	ClientID    string `json:"clientId"`
	RedirectURI string `json:"redirectUri"`
	Resource    string `json:"resource"`
	Scope       string `json:"scope"`
	Challenge   string `json:"challenge"`
	State       string `json:"state"`
}

type pendingGrant struct {
	Grant    grant  `json:"grant"`
	CSRF     string `json:"csrf"`
	Attempts int    `json:"attempts"`
}

type oauthToken struct {
	ClientID string `json:"clientId"`
	Resource string `json:"resource"`
	Scope    string `json:"scope"`
	Family   string `json:"family"`
}

type tokenFamily struct {
	Current string `json:"current"`
}

type oauthServer struct {
	endpoint                                                  model.EndpointConfig
	deps                                                      agentmcp.Dependencies
	config                                                    agentmcp.Config
	origin, secret, resource, issuer, metadataURL, cookieName string
	store                                                     oauthStore
	clients                                                   clientRegistry
}

func newOAuth(endpoint model.EndpointConfig, c agentmcp.Config, deps agentmcp.Dependencies) (*oauthServer, error) {
	origin, err := config.ValidatePublicURL(deps.Host.PublicURL())
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(origin, "https://") {
		return nil, errors.New("dot_oauth_requires_https")
	}
	secret, err := deps.Secret(c.Token)
	if err != nil {
		return nil, err
	}
	if len(secret) < 32 {
		return nil, errors.New("dot_oauth_password_too_short")
	}
	resource := origin + "/agents/dot/mcp/" + url.PathEscape(endpoint.ID)
	o := &oauthServer{endpoint: endpoint, deps: deps, config: c, origin: origin, secret: secret, resource: resource, issuer: origin + "/agents/dot/oauth/" + url.PathEscape(endpoint.ID), metadataURL: origin + "/.well-known/oauth-protected-resource/agents/dot/mcp/" + url.PathEscape(endpoint.ID), cookieName: "__Host-relanox-oauth-" + endpoint.ID}
	o.store = oauthStore{state: deps.Host.State(), prefix: "oauth/" + endpoint.ID + "/", secret: secret}
	o.clients = clientRegistry{secret: secret, resource: resource}
	if err = o.mountRoutes(); err != nil {
		return nil, err
	}
	return o, nil
}

func (o *oauthServer) hostAllowed(r *http.Request) bool {
	deployment, _ := url.Parse(o.origin)
	return r.Host == deployment.Host && (r.URL.Host == "" || r.URL.Host == deployment.Host)
}

func (o *oauthServer) mount(path string, methods []string, handler func(http.ResponseWriter, *http.Request) error) error {
	return o.deps.Host.MountHTTP(model.HTTPRoute{Pattern: path, MaxBodyBytes: 16 << 10, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !o.hostAllowed(r) {
			agentmcp.JSON(w, 403, map[string]string{"error": "invalid_request"})
			return
		}
		if !slices.Contains(methods, r.Method) {
			w.Header().Set("Allow", strings.Join(methods, ", "))
			w.WriteHeader(405)
			return
		}
		// Opaque grants and signed client metadata use the constructor's secret.
		// Rotation revokes this server consistently until a restart rebuilds it.
		if strings.HasPrefix(r.URL.Path, "/agents/dot/oauth/") {
			current, err := o.deps.Secret(o.config.Token)
			if err != nil || !agentmcp.EqualSecret(current, o.secret) {
				agentmcp.JSON(w, 503, map[string]string{"error": "temporarily_unavailable"})
				return
			}
		}
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if err := handler(w, r); err != nil {
			code, status := errorDetails(err)
			agentmcp.JSON(w, status, map[string]string{"error": code})
		}
	})})
}

func (o *oauthServer) mountRoutes() error {
	endpoint := url.PathEscape(o.endpoint.ID)
	routes := []struct {
		path    string
		methods []string
		handler func(http.ResponseWriter, *http.Request) error
	}{
		{"/.well-known/oauth-protected-resource/agents/dot/mcp/" + endpoint, []string{"GET"}, func(w http.ResponseWriter, _ *http.Request) error {
			agentmcp.JSON(w, 200, map[string]any{"resource": o.resource, "authorization_servers": []string{o.issuer}, "scopes_supported": []string{"relanox", "offline_access"}, "bearer_methods_supported": []string{"header"}})
			return nil
		}},
		{"/.well-known/oauth-authorization-server/agents/dot/oauth/" + endpoint, []string{"GET"}, func(w http.ResponseWriter, _ *http.Request) error {
			agentmcp.JSON(w, 200, map[string]any{"issuer": o.issuer, "authorization_endpoint": o.issuer + "/authorize", "token_endpoint": o.issuer + "/token", "registration_endpoint": o.issuer + "/register", "response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code", "refresh_token"}, "token_endpoint_auth_methods_supported": []string{"none"}, "code_challenge_methods_supported": []string{"S256"}, "scopes_supported": []string{"relanox", "offline_access"}, "authorization_response_iss_parameter_supported": true})
			return nil
		}},
		{"/agents/dot/oauth/" + endpoint + "/register", []string{"POST"}, o.register},
		{"/agents/dot/oauth/" + endpoint + "/authorize", []string{"GET", "POST"}, o.authorize},
		{"/agents/dot/oauth/" + endpoint + "/token", []string{"POST"}, o.token},
	}
	for _, route := range routes {
		if err := o.mount(route.path, route.methods, route.handler); err != nil {
			return err
		}
	}
	return nil
}

func (o *oauthServer) register(w http.ResponseWriter, r *http.Request) error {
	if mediaType(r) != "application/json" {
		return oauthFailure("invalid_client_metadata")
	}
	var client oauthClient
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
	if err != nil || json.Unmarshal(data, &client) != nil {
		return oauthFailure("invalid_client_metadata")
	}
	client, err = o.clients.register(client)
	if err != nil {
		return err
	}
	data, err = json.Marshal(client)
	if err != nil {
		return err
	}
	var result map[string]any
	if json.Unmarshal(data, &result) != nil {
		return oauthFailure("invalid_client_metadata")
	}
	result["client_id_issued_at"] = time.Now().Unix()
	agentmcp.JSON(w, 201, result)
	return nil
}

func mediaType(r *http.Request) string {
	value, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return value
}

func formBody(w http.ResponseWriter, r *http.Request) (url.Values, error) {
	if mediaType(r) != "application/x-www-form-urlencoded" {
		return nil, oauthFailure("invalid_request")
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
	if err != nil {
		return nil, oauthFailure("invalid_request")
	}
	form, err := url.ParseQuery(string(data))
	if err != nil || singleParameters(form) != nil {
		return nil, oauthFailure("invalid_request")
	}
	return form, nil
}

var challengePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var verifierPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)

func (o *oauthServer) validateGrant(query url.Values) (grant, string, error) {
	var zero grant
	if singleParameters(query) != nil || query.Get("response_type") != "code" || query.Get("code_challenge_method") != "S256" || !challengePattern.MatchString(query.Get("code_challenge")) || len(query.Get("state")) > 2048 {
		return zero, "", oauthFailure("invalid_request")
	}
	client, err := o.clients.resolve(query.Get("client_id"))
	if err != nil {
		return zero, "", err
	}
	if !slices.Contains(client.RedirectURIs, query.Get("redirect_uri")) {
		return zero, "", oauthFailure("invalid_request")
	}
	if query.Get("resource") != o.resource {
		return zero, "", oauthFailure("invalid_target")
	}
	if query.Has("scope") && query.Get("scope") == "" {
		return zero, "", oauthFailure("invalid_scope")
	}
	scope, err := requestedScope(query.Get("scope"))
	if err != nil {
		return zero, "", err
	}
	return grant{ClientID: client.ClientID, RedirectURI: query.Get("redirect_uri"), Resource: o.resource, Scope: scope, Challenge: query.Get("code_challenge"), State: query.Get("state")}, client.ClientName, nil
}

func (o *oauthServer) authorize(w http.ResponseWriter, r *http.Request) error {
	if r.Method == "GET" {
		return o.beginConsent(w, r)
	}
	form, err := formBody(w, r)
	if err != nil {
		return err
	}
	return o.finishConsent(w, r, form)
}

func (o *oauthServer) beginConsent(w http.ResponseWriter, r *http.Request) error {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return oauthFailure("invalid_request")
	}
	grant, name, err := o.validateGrant(query)
	if err != nil {
		return err
	}
	if err = o.store.capacity(r.Context(), "pending"); err != nil {
		return err
	}
	csrf := agentmcp.Opaque()
	pending, err := o.store.issue(r.Context(), "pending", pendingGrant{Grant: grant, CSRF: digest(csrf)}, pendingLifetime)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: o.cookieName, Value: csrf, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, Path: "/", MaxAge: 300})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://chatgpt.com")
	_, err = fmt.Fprintf(w, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Relanox</title><body><main><h1>Connect to Relanox / 连接 Relanox</h1><p>%s requests access to Agent <strong>%s</strong>.</p><p>Allow reading attachments, replying to this Agent's conversations and managing its message subscriptions.</p><form method="post" action="%s/authorize"><input type="hidden" name="request" value="%s"><label for="password">Authorization password / 授权口令</label><input id="password" name="password" type="password" required autocomplete="current-password"><button name="decision" value="allow">Allow / 授权</button><button name="decision" value="deny" formnovalidate>Cancel / 取消</button></form></main></body></html>`, html.EscapeString(name), html.EscapeString(o.endpoint.ID), html.EscapeString(o.issuer), pending)
	return err
}

func (o *oauthServer) finishConsent(w http.ResponseWriter, r *http.Request, form url.Values) error {
	var pending pendingGrant
	entry, err := o.store.load(r.Context(), "pending", form.Get("request"), &pending)
	if err != nil {
		return err
	}
	cookie, err := r.Cookie(o.cookieName)
	if r.Header.Get("Origin") != o.origin || err != nil || !agentmcp.EqualSecret(digest(cookie.Value), pending.CSRF) {
		return oauthError{"invalid_request", 403}
	}
	if form.Get("decision") == "deny" {
		if err = o.store.consume(r.Context(), entry); err != nil {
			return err
		}
		return o.redirect(w, pending.Grant, "error", "access_denied")
	}
	if form.Get("decision") != "allow" {
		return oauthFailure("invalid_request")
	}
	if pending.Attempts >= 10 {
		if err = o.store.consume(r.Context(), entry); err != nil {
			return err
		}
		return oauthError{"access_denied", 403}
	}
	if !agentmcp.EqualSecret(form.Get("password"), o.secret) {
		pending.Attempts++
		if err = o.store.update(r.Context(), entry, pending); err != nil {
			return err
		}
		return oauthError{"access_denied", 403}
	}
	if err = o.store.consume(r.Context(), entry); err != nil {
		return err
	}
	code, err := o.store.issue(r.Context(), "code", pending.Grant, codeLifetime)
	if err != nil {
		return err
	}
	return o.redirect(w, pending.Grant, "code", code)
}

func (o *oauthServer) redirect(w http.ResponseWriter, grant grant, parameter, value string) error {
	u, err := url.Parse(grant.RedirectURI)
	if err != nil || !nativeRedirect(grant.RedirectURI) {
		return oauthFailure("invalid_request")
	}
	query := u.Query()
	query.Set(parameter, value)
	query.Set("iss", o.issuer)
	if grant.State != "" {
		query.Set("state", grant.State)
	}
	u.RawQuery = query.Encode()
	http.SetCookie(w, &http.Cookie{Name: o.cookieName, Value: "", Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	w.Header().Set("Location", u.String())
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(303)
	return nil
}

func (o *oauthServer) token(w http.ResponseWriter, r *http.Request) error {
	form, err := formBody(w, r)
	if err != nil {
		return err
	}
	_, hasAuthorization := r.Header["Authorization"]
	if hasAuthorization || form.Has("client_secret") {
		return oauthError{"invalid_client", 401}
	}
	if _, err = o.clients.resolve(form.Get("client_id")); err != nil {
		return err
	}
	if form.Get("resource") != o.resource {
		return oauthFailure("invalid_target")
	}
	switch form.Get("grant_type") {
	case "authorization_code":
		return o.codeToken(w, r, form)
	case "refresh_token":
		return o.refreshToken(w, r, form)
	default:
		return oauthFailure("unsupported_grant_type")
	}
}

func (o *oauthServer) codeToken(w http.ResponseWriter, r *http.Request, form url.Values) error {
	var data grant
	entry, err := o.store.load(r.Context(), "code", form.Get("code"), &data)
	if err != nil {
		return err
	}
	verifier := form.Get("code_verifier")
	if data.ClientID != form.Get("client_id") || data.RedirectURI != form.Get("redirect_uri") || data.Resource != o.resource || !verifierPattern.MatchString(verifier) || !agentmcp.EqualSecret(digest(verifier), data.Challenge) {
		return oauthFailure("invalid_grant")
	}
	if err = o.store.consume(r.Context(), entry); err != nil {
		return err
	}
	refresh := agentmcp.Opaque()
	token := oauthToken{ClientID: data.ClientID, Resource: o.resource, Scope: data.Scope, Family: agentmcp.Opaque()}
	if err = o.store.save(r.Context(), "family", token.Family, tokenFamily{Current: digest(refresh)}, refreshLifetime); err != nil {
		return err
	}
	if err = o.store.save(r.Context(), "refresh", refresh, token, refreshLifetime); err != nil {
		return err
	}
	return o.issueTokens(r.Context(), w, token, refresh)
}

func (o *oauthServer) refreshToken(w http.ResponseWriter, r *http.Request, form url.Values) error {
	var data oauthToken
	value := form.Get("refresh_token")
	if _, err := o.store.load(r.Context(), "refresh", value, &data); err != nil {
		return err
	}
	if data.ClientID != form.Get("client_id") || data.Resource != o.resource {
		return oauthFailure("invalid_grant")
	}
	access := data
	if form.Has("scope") {
		var err error
		access.Scope, err = refreshAccessScope(data.Scope, form.Get("scope"))
		if err != nil {
			return err
		}
	}
	var family tokenFamily
	entry, err := o.store.load(r.Context(), "family", data.Family, &family)
	if err != nil {
		return err
	}
	if !agentmcp.EqualSecret(family.Current, digest(value)) {
		if err = o.store.consume(r.Context(), entry); err != nil {
			return err
		}
		return oauthFailure("invalid_grant")
	}
	next := agentmcp.Opaque()
	if err = o.store.update(r.Context(), entry, tokenFamily{Current: digest(next)}); err != nil {
		return err
	}
	if err = o.store.save(r.Context(), "refresh", next, data, max(time.Millisecond, time.Until(*entry.ExpiresAt))); err != nil {
		return err
	}
	return o.issueTokens(r.Context(), w, access, next)
}

func (o *oauthServer) issueTokens(ctx context.Context, w http.ResponseWriter, token oauthToken, refresh string) error {
	access, err := o.store.issue(ctx, "access", token, accessLifetime)
	if err != nil {
		return err
	}
	agentmcp.JSON(w, 200, map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": int(accessLifetime / time.Second), "refresh_token": refresh, "scope": token.Scope})
	return nil
}

func (o *oauthServer) authenticate(w http.ResponseWriter, r *http.Request) bool {
	secret, err := o.deps.Secret(o.config.Token)
	valid := err == nil && agentmcp.EqualSecret(o.secret, secret)
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || !challengePattern.MatchString(token) {
		valid = false
	}
	var data oauthToken
	if valid {
		entry, e := o.store.read(r.Context(), "access", token)
		valid = e == nil && entry != nil
		if valid {
			valid = json.Unmarshal(entry.Value, &data) == nil && data.Resource == o.resource && slices.Contains(strings.Fields(data.Scope), "relanox")
			if valid {
				family, e := o.store.read(r.Context(), "family", data.Family)
				valid = e == nil && family != nil
			}
		}
	}
	if valid {
		return true
	}
	w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s", scope="relanox"`, o.metadataURL))
	agentmcp.JSON(w, 401, map[string]string{"error": "unauthorized"})
	return false
}
