package agentmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

type Options struct {
	Endpoint      model.EndpointConfig
	Config        Config
	Dependencies  Dependencies
	ModernOnly    bool
	Authenticate  func(http.ResponseWriter, *http.Request) bool
	Configure     func(*mcp.Server) error
	StatusContext func(context.Context) (map[string]any, error)
}

type Server struct {
	Options Options
	Host    model.ScopedAgentHost
	Origin  string
	SDK     *mcp.Server
	handler http.Handler
}

func New(options Options) (*Server, error) {
	if options.Dependencies.Host == nil || !ID(options.Endpoint.ID) || !options.Endpoint.Agent.Valid() {
		return nil, errors.New("invalid_agent_dependencies")
	}
	origin, err := config.ValidatePublicURL(options.Dependencies.Host.PublicURL())
	if err != nil {
		return nil, err
	}
	if err = options.Config.Validate("bearer", "path", "oauth"); err != nil {
		return nil, err
	}
	scoped, err := options.Dependencies.Host.ForPrincipal(context.Background(), model.Principal{Subject: options.Endpoint.ID, EndpointIDs: []string{options.Endpoint.ID}})
	if err != nil {
		return nil, err
	}
	s := &Server{Options: options, Host: scoped, Origin: origin}
	serverOptions := &mcp.ServerOptions{Instructions: Instructions(options.Endpoint.Agent), Capabilities: &mcp.ServerCapabilities{}}
	if options.ModernOnly {
		serverOptions.SupportedProtocolVersions = []string{"2026-07-28"}
	}
	s.SDK = mcp.NewServer(&mcp.Implementation{Name: "relanox-" + string(options.Endpoint.Agent), Version: "0.1.0"}, serverOptions)
	s.registerTools()
	if options.Configure != nil {
		if err = options.Configure(s.SDK); err != nil {
			return nil, err
		}
	}
	// ServeHTTP always checks the configured deployment Host and allowed Origin
	// before reaching this private handler. That guard also supports reverse
	// proxies preserving a public Host while connecting to a loopback listener.
	s.handler = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s.SDK }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 1 << 20, PropagateRequestCancellation: true, DisableLocalhostProtection: true})
	prefix := "/agents/" + string(options.Endpoint.Agent) + "/mcp/" + url.PathEscape(options.Endpoint.ID)
	if err = options.Dependencies.Host.MountHTTP(model.HTTPRoute{Pattern: prefix, Handler: s, MaxBodyBytes: 1 << 20}); err != nil {
		return nil, err
	}
	if options.Config.Auth == "path" {
		if err = options.Dependencies.Host.MountHTTP(model.HTTPRoute{Pattern: prefix + "/", Handler: s, MaxBodyBytes: 1 << 20}); err != nil {
			return nil, err
		}
	}
	if scoped.Media() != nil {
		if err = s.mountMedia(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.GuardHost(w, r) {
		return
	}
	if s.Options.Authenticate != nil {
		if !s.Options.Authenticate(w, r) {
			return
		}
	} else if !s.authenticate(w, r) {
		return
	}
	if r.Context().Err() != nil {
		JSON(w, 408, map[string]string{"error": "request_timeout"})
		return
	}
	if r.Body != nil {
		data, err := readRequestBody(w, r, 1<<20, 10*time.Second)
		if err != nil {
			status := http.StatusRequestTimeout
			var large *http.MaxBytesError
			if errors.As(err, &large) {
				status = 413
			}
			JSON(w, status, map[string]string{"error": "request_body_unavailable"})
			return
		}
		if s.Options.ModernOnly {
			var envelope struct {
				Method string `json:"method"`
			}
			if json.Unmarshal(data, &envelope) == nil && envelope.Method == "initialize" {
				JSON(w, 400, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32600, "message": "Use MCP 2026-07-28 stateless requests"}})
				return
			}
		}
		r = r.Clone(r.Context())
		r.Body = io.NopCloser(bytes.NewReader(data))
		r.ContentLength = int64(len(data))
	}
	if s.Options.Endpoint.Agent != model.Dot {
		s.handler.ServeHTTP(w, r)
		return
	}
	// The Events draft and OpenAI tool security metadata are outside the SDK's
	// closed result structs. Preserve its negotiation, schema and dispatch logic;
	// augment only successful JSON discovery responses at the final wire edge.
	buffer := &bufferedResponse{header: make(http.Header)}
	s.handler.ServeHTTP(buffer, r)
	data := s.augmentDotDiscovery(buffer.body.Bytes())
	for k, values := range buffer.header {
		for _, v := range values {
			w.Header().Add(k, v)
		}
	}
	w.Header().Del("Content-Length")
	status := buffer.status
	if status == 0 {
		status = 200
	}
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func (s *Server) GuardHost(w http.ResponseWriter, r *http.Request) bool {
	if !s.allowedRequestOrigin(r) {
		JSON(w, 403, map[string]string{"error": "forbidden_origin"})
		return false
	}
	return true
}

func (s *Server) allowedRequestOrigin(r *http.Request) bool {
	deployment, _ := url.Parse(s.Origin)
	origin := r.Header.Get("Origin")
	return r.Host == deployment.Host && (r.URL.Host == "" || r.URL.Host == deployment.Host) && (origin == "" || slices.Contains(s.Options.Config.AllowedOrigins, origin))
}

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) bool {
	secret, err := s.Options.Dependencies.Secret(s.Options.Config.Token)
	if err != nil {
		JSON(w, 401, map[string]string{"error": "unauthorized"})
		return false
	}
	token := ""
	if s.Options.Config.Auth == "path" {
		prefix := "/agents/" + string(s.Options.Endpoint.Agent) + "/mcp/" + url.PathEscape(s.Options.Endpoint.ID) + "/"
		if strings.HasPrefix(r.URL.EscapedPath(), prefix) {
			segment := strings.TrimPrefix(r.URL.EscapedPath(), prefix)
			if segment != "" && !strings.Contains(segment, "/") {
				token, _ = url.PathUnescape(segment)
			}
		}
	} else if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if strings.ContainsAny(token, " \t\r\n") {
			token = ""
		}
	}
	if token == "" || !EqualSecret(secret, token) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="relanox"`)
		JSON(w, 401, map[string]string{"error": "unauthorized"})
		return false
	}
	return true
}

func readRequestBody(w http.ResponseWriter, r *http.Request, maxBytes int64, timeout time.Duration) ([]byte, error) {
	if r.Context().Err() != nil {
		return nil, r.Context().Err()
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(timeout))
	// Some HTTP writers do not support deadlines; resetting is best effort.
	defer func() { _ = controller.SetReadDeadline(time.Time{}) }()
	return io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
}

type bufferedResponse struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (w *bufferedResponse) Header() http.Header { return w.header }

func (w *bufferedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *bufferedResponse) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return w.body.Write(data)
}

func (s *Server) augmentDotDiscovery(data []byte) []byte {
	var body map[string]json.RawMessage
	if json.Unmarshal(data, &body) != nil {
		return data
	}
	var result map[string]any
	if json.Unmarshal(body["result"], &result) != nil {
		return data
	}
	if capabilities, ok := result["capabilities"].(map[string]any); ok {
		capabilities["events"] = map[string]any{}
	}
	if tools, ok := result["tools"].([]any); ok {
		for _, value := range tools {
			tool, ok := value.(map[string]any)
			if !ok {
				continue
			}
			schemes := []any{map[string]any{"type": "oauth2", "scopes": []string{"relanox"}}}
			tool["securitySchemes"] = schemes
			meta, ok := tool["_meta"].(map[string]any)
			if !ok {
				meta = map[string]any{}
			}
			meta["securitySchemes"] = schemes
			tool["_meta"] = meta
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return data
	}
	body["result"] = encoded
	encoded, err = json.Marshal(body)
	if err != nil {
		return data
	}
	return encoded
}
