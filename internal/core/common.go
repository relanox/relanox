package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"path"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/transport"
)

const maxTextBytes = 1 << 20

func canonical(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var normalized any
	if decoder.Decode(&normalized) != nil {
		return nil
	}
	data, _ = json.Marshal(normalized)
	return data
}

func equal(a, b any) bool {
	left, right := canonical(a), canonical(b)
	return left != nil && right != nil && bytes.Equal(left, right)
}

func fingerprint(value any) string {
	sum := sha256.Sum256(canonical(value))
	return hex.EncodeToString(sum[:])
}

func bindingKey(account, chat, thread string) [3]string { return [3]string{account, chat, thread} }

func conversationAddress(binding model.Binding, endpoint model.EndpointConfig, kind model.ChannelKind) model.ChannelAddress {
	id := fingerprint([]any{kind, binding.AccountID, binding.ChatID, binding.ThreadID, endpoint})
	return model.ChannelAddress{ID: id, Platform: kind, AccountID: binding.AccountID, ChatID: binding.ChatID, ThreadID: binding.ThreadID}
}

func validID(value string, maximum int) bool {
	if value == "" || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func validText(value string, empty bool) error {
	if !utf8.ValidString(value) || len(value) > maxTextBytes || !empty && strings.TrimSpace(value) == "" {
		return failure("invalid_message_text")
	}
	return nil
}

type commonHost struct {
	runtime   *Runtime
	namespace model.StateNamespace
	prefix    string
}

func (h *commonHost) PublicURL() string { return strings.TrimSuffix(h.runtime.cfg.HTTP.PublicURL, "/") }

func (h *commonHost) Observer() model.Observer { return h.runtime.observe }

func (h *commonHost) State() model.StateStore {
	return &scopedState{store: h.runtime.store, namespace: h.namespace}
}

func (h *commonHost) Connection(status model.ConnectionStatus, code string) {
	if !slices.Contains([]model.ConnectionStatus{model.Connected, model.Disconnected, model.Degraded}, status) {
		return
	}
	h.runtime.mu.Lock()
	h.runtime.connections[h.prefix] = status
	h.runtime.mu.Unlock()
	h.runtime.observe.Log(context.Background(), "info", "connection.changed", model.LogFields{Component: h.namespace.Component, Outcome: string(status), ErrorCode: code})
}

func (h *commonHost) MountHTTP(route model.HTTPRoute) error {
	if route.Handler == nil || route.MaxBodyBytes < 0 || route.MaxBodyBytes > 200<<20 {
		return failure("invalid_http_route")
	}
	pattern, err := h.routePattern(route.Pattern)
	if err != nil {
		return err
	}
	route.Pattern = pattern
	if route.MaxBodyBytes == 0 {
		route.MaxBodyBytes = h.runtime.cfg.HTTP.MaxBodyBytes
	}
	return h.runtime.mount(route)
}

func (h *commonHost) routePattern(pattern string) (string, error) {
	if !validRoute(pattern) {
		return "", failure("invalid_route_path")
	}
	if strings.HasPrefix(h.prefix, "/channels/") {
		if strings.HasPrefix(pattern, "/channels/") {
			if pattern != h.prefix && !strings.HasPrefix(pattern, h.prefix+"/") {
				return "", failure("route_scope_mismatch")
			}
			return pattern, nil
		}
		return h.prefix + pattern, nil
	}
	if strings.HasPrefix(pattern, h.prefix+"/") && h.agentPattern(pattern) {
		return pattern, nil
	}
	for _, discovery := range []string{"/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"} {
		if strings.HasPrefix(pattern, discovery+h.prefix+"/") && h.agentPattern(strings.TrimPrefix(pattern, discovery)) {
			return pattern, nil
		}
	}
	return "", failure("route_scope_mismatch")
}

func validRoute(value string) bool {
	clean := strings.TrimSuffix(value, "/")
	if clean == "" {
		clean = "/"
	}
	return strings.HasPrefix(value, "/") && len(value) <= 2048 && !strings.ContainsAny(value, "?#\\{} \t\r\n") && !strings.Contains(value, "//") && !strings.Contains(value, "..") && path.Clean(value) == clean
}

func (h *commonHost) agentPattern(value string) bool {
	parts := strings.Split(strings.Trim(value, "/"), "/")
	if len(parts) < 4 || !slices.Contains([]string{"mcp", "media", "oauth"}, parts[2]) {
		return false
	}
	endpoint, ok := h.runtime.endpoints[parts[3]]
	return ok && string(endpoint.Agent) == parts[1] && h.prefix == "/agents/"+parts[1]
}

func (r *Runtime) mount(route model.HTTPRoute) (err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.routes[route.Pattern] {
		return failure("duplicate_route")
	}
	defer func() {
		if recover() != nil {
			err = failure("conflicting_http_route")
		}
	}()
	handler := transport.RouteHandler(route)
	r.mux.Handle(route.Pattern, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !r.accepting.Load() {
			http.Error(w, "not_accepting", http.StatusServiceUnavailable)
			return
		}
		handler.ServeHTTP(w, request)
	}))
	r.routes[route.Pattern] = true
	return nil
}

type scopedState struct {
	store     model.Storage
	namespace model.StateNamespace
}

func (s *scopedState) Get(ctx context.Context, key string) (*model.StateEntry, error) {
	if !validID(key, 2048) {
		return nil, failure("invalid_state_key")
	}
	return s.store.GetState(ctx, s.namespace, key)
}

func (s *scopedState) List(ctx context.Context, input model.ListStateInput) ([]model.StateEntry, error) {
	if input.Limit == 0 {
		input.Limit = 100
	}
	if input.Limit < 1 || input.Limit > 1000 || len(input.Prefix) > 2048 {
		return nil, failure("invalid_state_query")
	}
	return s.store.ListState(ctx, s.namespace, input)
}

func (s *scopedState) CompareAndSet(ctx context.Context, input model.CompareAndSetStateInput) (model.MutationResult, error) {
	if !validID(input.Key, 2048) || len(input.Value) > 4<<20 || !json.Valid(input.Value) {
		return model.MutationResult{}, failure("invalid_state_entry")
	}
	return s.store.CompareAndSetState(ctx, s.namespace, input)
}

func (s *scopedState) Delete(ctx context.Context, key string, version int64) (model.MutationResult, error) {
	if !validID(key, 2048) || version < 1 {
		return model.MutationResult{}, failure("invalid_state_entry")
	}
	return s.store.DeleteState(ctx, s.namespace, key, version)
}

type noopObserver struct{}

func (noopObserver) Log(context.Context, string, string, model.LogFields) {}

func (noopObserver) Count(string, model.MetricLabels, int64) {}

func (noopObserver) Record(string, float64, model.MetricLabels) {}

func (noopObserver) Span(ctx context.Context, _ string, _ model.LogFields, trace *model.TraceContext) (context.Context, model.Span) {
	return ctx, noopSpan{trace: trace}
}

type noopSpan struct{ trace *model.TraceContext }

func (s noopSpan) Context() *model.TraceContext { return s.trace }

func (noopSpan) End(string) {}
