package agentmcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/transport"
)

// Exercises production HTTP guards followed by the real official MCP SDK.
// Host/origin confusion, weak credential parsing or an unread oversized body
// would otherwise expose parsers or tools before authentication. Native agent
// trigger tests only cover outbound traffic. No fake core implements permissions.
func TestMCPGuardsBeforeParsingAndReadsRotatedSecrets(t *testing.T) {
	t.Setenv("MCP_TOKEN", "first-token")
	var endpoint *Server
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { endpoint.ServeHTTP(w, r) }))
	defer peer.Close()
	endpoint = protocolServer(peer.URL, "bearer", model.Grok)
	for _, row := range []struct {
		name, authorization, origin, host, body string
		want                                    int
	}{
		{"missing", "", "", "", "invalid json", 401},
		{"wrong", "Bearer wrong", "", "", "invalid json", 401},
		{"bad-origin", "Bearer first-token", "https://untrusted.example", "", "invalid json", 403},
		{"bad-host", "Bearer first-token", "", "different.example", "invalid json", 403},
		{"oversized", "Bearer first-token", "", "", strings.Repeat("a", 1<<20+1), 413},
		{"valid", "Bearer first-token", "https://trusted.example", "", discoverBody(), 200},
	} {
		t.Run(row.name, func(t *testing.T) {
			req, err := http.NewRequest("POST", peer.URL+"/agents/grok/mcp/endpoint-A", strings.NewReader(row.body))
			if err != nil {
				t.Fatal(err)
			}
			setMCPHeaders(req)
			if row.authorization != "" {
				req.Header.Set("Authorization", row.authorization)
			}
			if row.origin != "" {
				req.Header.Set("Origin", row.origin)
			}
			if row.host != "" {
				req.Host = row.host
			}
			response, err := peer.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			data, _ := io.ReadAll(response.Body)
			if response.StatusCode != row.want {
				t.Fatalf("status=%d body=%s", response.StatusCode, data)
			}
			if row.name == "valid" {
				var wire struct {
					Result struct {
						Meta struct {
							ServerInfo struct {
								Name string `json:"name"`
							} `json:"io.modelcontextprotocol/serverInfo"`
						} `json:"_meta"`
					} `json:"result"`
				}
				if json.Unmarshal(data, &wire) != nil || wire.Result.Meta.ServerInfo.Name != "protocol-peer" {
					t.Fatalf("not an MCP discovery: %s", data)
				}
			}
		})
	}
	t.Setenv("MCP_TOKEN", "rotated-token")
	request := httptest.NewRequest("POST", peer.URL+"/agents/grok/mcp/endpoint-A", strings.NewReader(discoverBody()))
	setMCPHeaders(request)
	request.Header.Set("Authorization", "Bearer first-token")
	w := httptest.NewRecorder()
	endpoint.ServeHTTP(w, request)
	if w.Code != 401 {
		t.Fatal("old secret survived rotation")
	}
	request.Header.Set("Authorization", "Bearer rotated-token")
	w = httptest.NewRecorder()
	endpoint.ServeHTTP(w, request)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestPathAuthenticationPreservesEncodedSingleSegment(t *testing.T) {
	t.Setenv("MCP_TOKEN", "slash/plus+percent% and space")
	s := protocolServer("http://127.0.0.1:8787", "path", model.Muse)
	for _, row := range []struct {
		suffix string
		want   int
	}{{url.PathEscape("slash/plus+percent% and space"), 200}, {"wrong", 401}, {"first/second", 401}, {"", 401}} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8787/agents/muse/mcp/endpoint-A/"+row.suffix, strings.NewReader(discoverBody()))
		setMCPHeaders(r)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != row.want {
			t.Fatalf("suffix=%s code=%d %s", row.suffix, w.Code, w.Body.String())
		}
	}
}

func TestAlreadyCancelledBodyIsNeverRead(t *testing.T) {
	t.Setenv("MCP_TOKEN", "token")
	s := protocolServer("http://127.0.0.1:8787", "bearer", model.Grok)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	body := &recordedBody{}
	r := httptest.NewRequest("POST", "http://127.0.0.1:8787/agents/grok/mcp/endpoint-A", body).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer token")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 408 || body.reads.Load() != 0 {
		t.Fatal("cancelled request reached body parser", w.Code, body.reads.Load())
	}
}

type recordedBody struct{ reads atomic.Int32 }

func (b *recordedBody) Read([]byte) (int, error) { b.reads.Add(1); return 0, io.EOF }

func (b *recordedBody) Close() error { return nil }

func protocolServer(origin, auth string, kind model.AgentKind) *Server {
	sdk := mcp.NewServer(&mcp.Implementation{Name: "protocol-peer", Version: "1"}, &mcp.ServerOptions{Capabilities: &mcp.ServerCapabilities{}})
	return &Server{Origin: origin, Options: Options{Endpoint: model.EndpointConfig{ID: "endpoint-A", Agent: kind}, Config: Config{Auth: auth, Token: model.SecretRef{Env: "MCP_TOKEN"}, AllowedOrigins: []string{"https://trusted.example"}}}, SDK: sdk, handler: mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return sdk }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, PropagateRequestCancellation: true})}
}

func discoverBody() string {
	return `{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}`
}

func setMCPHeaders(r *http.Request) {
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("MCP-Protocol-Version", "2026-07-28")
	r.Header.Set("Mcp-Method", "server/discover")
}

// This uses the actual constructor and SDK schema validation. The host exposes
// no implementation of core behavior: every message operation panics, so an
// invalid payload reaching it fails the test rather than returning a fake result.
func TestConstructorRegistersTypedToolSchemas(t *testing.T) {
	t.Setenv("MCP_TOKEN", "token")
	mux := http.NewServeMux()
	peer := httptest.NewServer(mux)
	defer peer.Close()
	host := &registrationHost{origin: peer.URL, mux: mux}
	server, err := New(Options{Endpoint: model.EndpointConfig{ID: "endpoint-A", Agent: model.Muse}, Config: Config{Auth: "bearer", Token: model.SecretRef{Env: "MCP_TOKEN"}}, Dependencies: Dependencies{Host: host}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	request := func(method string, params map[string]any) []byte {
		params["_meta"] = map[string]any{"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": map[string]any{}}
		data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
		if err != nil {
			t.Fatal(err)
		}
		r, err := http.NewRequest("POST", peer.URL+"/agents/muse/mcp/endpoint-A", strings.NewReader(string(data)))
		if err != nil {
			t.Fatal(err)
		}
		setMCPHeaders(r)
		r.Header.Set("Mcp-Method", method)
		r.Header.Set("Authorization", "Bearer token")
		if method == "tools/call" {
			r.Header.Set("Mcp-Name", params["name"].(string))
		}
		resp, err := peer.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	data := request("tools/list", map[string]any{})
	var discovery struct {
		Result struct {
			Tools []struct {
				Name   string         `json:"name"`
				Schema map[string]any `json:"inputSchema"`
			} `json:"tools"`
		} `json:"result"`
	}
	if json.Unmarshal(data, &discovery) != nil || len(discovery.Result.Tools) != 3 {
		t.Fatalf("invalid tool discovery %s", data)
	}
	for _, tool := range discovery.Result.Tools {
		if tool.Name != "relanox_send_message" {
			continue
		}
		properties := tool.Schema["properties"].(map[string]any)
		if properties["reply"] == nil || properties["attachments"] == nil || properties["files"] != nil {
			t.Fatalf("invalid Muse send schema %s", data)
		}
	}
	data = request("tools/call", map[string]any{"name": "relanox_send_message", "arguments": map[string]any{"channel": "channel-A", "reply": map[string]any{"requestId": "request-A", "kind": "unsupported"}}})
	var failure struct {
		Result struct {
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if json.Unmarshal(data, &failure) != nil || !failure.Result.IsError {
		t.Fatalf("invalid input reached tools: %s", data)
	}
}

type registrationHost struct {
	origin string
	mux    *http.ServeMux
}

func (h *registrationHost) PublicURL() string { return h.origin }

func (h *registrationHost) State() model.StateStore { panic("unexpected state access") }

func (h *registrationHost) Observer() model.Observer { panic("unexpected observer access") }

func (h *registrationHost) Connection(model.ConnectionStatus, string) {
	panic("unexpected connection access")
}

func (h *registrationHost) MountHTTP(route model.HTTPRoute) error {
	h.mux.Handle(route.Pattern, transport.RouteHandler(route))
	return nil
}

func (h *registrationHost) ForPrincipal(context.Context, model.Principal) (model.ScopedAgentHost, error) {
	return unavailableScope{}, nil
}

type unavailableScope struct{}

func (unavailableScope) Media() model.AgentMediaHost { return nil }

func (unavailableScope) Status(context.Context, model.StatusInput) (model.AgentStatus, error) {
	panic("unexpected status access")
}

func (unavailableScope) SendMessage(context.Context, model.SendMessageInput) (model.MessageReceipt, error) {
	panic("unexpected send access")
}

func (unavailableScope) ReadMessages(context.Context, model.ReadMessagesInput) ([]model.AgentMessage, error) {
	panic("unexpected recovery access")
}

// Capability tickets must bind endpoint, channel, media, path, method, expiry and
// signing domain. A GET link must never become an upload capability. These are
// protocol checks on actual signed URLs; storage ownership is tested with core.
func TestMediaCapabilitiesAreBoundAndRotateWithSecret(t *testing.T) {
	t.Setenv("MCP_TOKEN", "first-secret")
	s := protocolServer("https://relanox.example", "bearer", model.Muse)
	ticket := mediaTicket{EndpointID: "endpoint-A", ChannelID: "channel-1", MediaID: "media-2", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	uri, err := s.issueTicket(ticket, false)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", uri, nil)
	decoded, upload, err := s.decodeTicket(r)
	if err != nil || upload || decoded.ChannelID != "channel-1" {
		t.Fatal(decoded, upload, err)
	}
	for _, mutate := range []func(*http.Request){func(r *http.Request) { r.Method = "PUT" }, func(r *http.Request) { r.Host = "other.example" }, func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, func(r *http.Request) { r.URL.Path = strings.Replace(r.URL.Path, "channel-1", "channel-2", 1) }, func(r *http.Request) { r.URL.Path = strings.Replace(r.URL.Path, "endpoint-A", "endpoint-B", 1) }, func(r *http.Request) {
		r.URL.Path = strings.Replace(r.URL.Path, "/media/endpoint-A/", "/media/endpoint-A/upload/", 1)
		r.Method = "PUT"
	}} {
		request := httptest.NewRequest("GET", uri, nil)
		mutate(request)
		if _, _, err = s.decodeTicket(request); err == nil {
			t.Fatal("accepted changed capability")
		}
	}
	ticket.ExpiresAt = time.Now().Add(-time.Minute).UnixMilli()
	expired, err := s.issueTicket(ticket, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.decodeTicket(httptest.NewRequest("GET", expired, nil)); err == nil {
		t.Fatal("accepted expired capability")
	}
	t.Setenv("MCP_TOKEN", "rotated-secret")
	if _, _, err = s.decodeTicket(r); err == nil {
		t.Fatal("old signed ticket survived rotation")
	}
}

// The status tool must keep its public fields when dot adds connection metadata.
// Existing protocol tests stop at discovery or reject tool input. This exercises
// actual MCP serialization; the host only supplies a fixed status snapshot and
// does not implement JSON encoding, routing, authorization or persistence.
func TestStatusWirePreservesFieldsWithConnectionMetadata(t *testing.T) {
	t.Setenv("MCP_TOKEN", "token")
	s := protocolServer("http://127.0.0.1:8787", "bearer", model.Dot)
	s.Host = statusSnapshotScope{}
	s.Options.StatusContext = func(context.Context) (map[string]any, error) {
		return map[string]any{"endpointId": "endpoint-A", "eventName": "relanox.message_available", "activeSubscriptions": 2}, nil
	}
	s.registerTools()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"relanox_status","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}`
	r := httptest.NewRequest("POST", s.Origin+"/agents/dot/mcp/endpoint-A", strings.NewReader(body))
	setMCPHeaders(r)
	r.Header.Set("Mcp-Method", "tools/call")
	r.Header.Set("Mcp-Name", "relanox_status")
	r.Header.Set("Authorization", "Bearer token")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var response struct {
		Result struct {
			IsError    bool            `json:"isError"`
			Structured json.RawMessage `json:"structuredContent"`
			Content    []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != http.StatusOK || response.Result.IsError {
		t.Fatalf("status response: %d %s (%v)", w.Code, w.Body.String(), err)
	}
	if len(response.Result.Content) != 1 {
		t.Fatalf("expected one JSON text result: %s", w.Body.String())
	}
	var want map[string]any
	if err := json.Unmarshal([]byte(`{"channels":[],"mediaLimits":{"maxBytes":1024,"maxTotalBytes":2048,"maxAttachments":2},"delivery":{"id":"delivery-A","channel":"channel-A","status":"sent"},"connection":{"endpointId":"endpoint-A","eventName":"relanox.message_available","activeSubscriptions":2}}`), &want); err != nil {
		t.Fatal(err)
	}
	for _, data := range []json.RawMessage{response.Result.Structured, json.RawMessage(response.Result.Content[0].Text)} {
		var fields map[string]any
		if err := json.Unmarshal(data, &fields); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(fields, want) {
			t.Fatalf("status fields changed: %s", data)
		}
	}
}

type statusSnapshotScope struct{ unavailableScope }

func (statusSnapshotScope) Status(context.Context, model.StatusInput) (model.AgentStatus, error) {
	return model.AgentStatus{MediaLimits: model.MediaLimits{MaxBytes: 1024, MaxTotalBytes: 2048, MaxAttachments: 2}, Delivery: &model.DeliverySummary{ID: "delivery-A", Channel: "channel-A", Status: model.DeliverySent}}, nil
}
