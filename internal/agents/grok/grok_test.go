package grok

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/model"
)

// Protects the public Routine trigger wire contract: request correlation,
// original-conversation channel and metadata-only media payloads. Credible
// regressions are losing requestId, including captured credentials, or flattening
// source identifiers. Native Muse tests do not cover this HTTP envelope. The peer
// records actual traffic and implements no Relanox routing or persistence.
func TestRoutineDispatchProjectsExactRequestAndRotatesReferences(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		index := calls.Add(1)
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer rotated" {
			t.Error("invalid Routine credentials")
		}
		var envelope struct {
			Content string `json:"content"`
			Source  string `json:"source"`
			SentAt  string `json:"sentAt"`
		}
		if json.NewDecoder(r.Body).Decode(&envelope) != nil || envelope.Source != "relanox" || envelope.SentAt != "2026-10-17T01:02:03.004Z" {
			t.Error("invalid Routine envelope")
		}
		var content map[string]json.RawMessage
		if json.Unmarshal([]byte(envelope.Content), &content) != nil {
			t.Error("invalid content JSON")
		}
		var id string
		_ = json.Unmarshal(content["requestId"], &id)
		if index == 1 && id != "request-first" || index == 2 && id != "request-second" {
			t.Errorf("lost exact request ID: %s", id)
		}
		var source struct {
			Channel  model.ChannelAddress `json:"channel"`
			SenderID string               `json:"senderId"`
		}
		_ = json.Unmarshal(content["source"], &source)
		if source.Channel.ChatID != "native-chat-9001" || source.Channel.ID != "authorized-channel" || source.SenderID != "sender-7" {
			t.Errorf("wrong source %+v", source)
		}
		if _, ok := content["endpoint"]; ok {
			t.Error("leaked endpoint configuration")
		}
		var attachments []map[string]any
		_ = json.Unmarshal(content["attachments"], &attachments)
		if len(attachments) != 1 || attachments[0]["id"] != "media-native" || attachments[0]["data"] != nil {
			t.Error("invalid media projection")
		}
		w.WriteHeader(202)
	}))
	defer server.Close()
	t.Setenv("GROK_ROUTINE", server.URL)
	t.Setenv("GROK_AUTH", "Bearer original")
	endpoint := routineEndpoint(t)
	a := &Agent{endpoint: endpoint, deps: agentmcp.Dependencies{HTTPClient: server.Client()}}
	t.Setenv("GROK_AUTH", "Bearer rotated")
	request := routineInput(endpoint)
	for _, id := range []string{"request-first", "request-second"} {
		request.Request.RequestID = id
		result, err := a.Dispatch(context.Background(), request)
		if err != nil || result.Status != model.Accepted {
			t.Fatal(result, err)
		}
	}
	if calls.Load() != 2 {
		t.Fatal("lost independent Routine invocation")
	}
}

func TestRoutineReceiptAndUncertainTransportOutcomes(t *testing.T) {
	for _, row := range []struct {
		status int
		want   model.Outcome
	}{{202, model.Accepted}, {408, model.Unknown}, {429, model.Retryable}, {503, model.Retryable}, {302, model.Rejected}, {401, model.Rejected}} {
		t.Run(http.StatusText(row.status), func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Retry-After", "7200")
				w.WriteHeader(row.status)
			}))
			defer server.Close()
			t.Setenv("GROK_ROUTINE", server.URL)
			t.Setenv("GROK_AUTH", "Bearer secret")
			endpoint := routineEndpoint(t)
			a := &Agent{endpoint: endpoint, deps: agentmcp.Dependencies{HTTPClient: server.Client()}}
			result, err := a.Dispatch(context.Background(), routineInput(endpoint))
			if err != nil || result.Status != row.want {
				t.Fatal(result, err)
			}
			if row.want == model.Retryable && result.RetryAfter != time.Hour {
				t.Fatal("Retry-After not bounded", result.RetryAfter)
			}
		})
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		conn, _, err := http.NewResponseController(w).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}))
	defer server.Close()
	t.Setenv("GROK_ROUTINE", server.URL)
	t.Setenv("GROK_AUTH", "Bearer secret")
	endpoint := routineEndpoint(t)
	a := &Agent{endpoint: endpoint, deps: agentmcp.Dependencies{HTTPClient: server.Client()}}
	result, err := a.Dispatch(context.Background(), routineInput(endpoint))
	if err != nil || result.Status != model.Unknown {
		t.Fatal(result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err = a.Dispatch(ctx, routineInput(endpoint))
	if err != nil || result.Status != model.Retryable {
		t.Fatal(result, err)
	}
}

func TestRoutineValidationIsOfflineAndStrict(t *testing.T) {
	for _, raw := range []string{`{"mcp":{"token":{"env":"TOKEN"},"auth":"oauth"},"routineUrl":{"env":"URL"},"routineAuthorization":{"env":"AUTH"}}`, `{"mcp":{"token":{"env":"TOKEN"}},"routineUrl":"secret","routineAuthorization":{"env":"AUTH"}}`, `{"mcp":{"token":{"env":"TOKEN"}},"routineUrl":{"env":"URL"},"routineAuthorization":{"env":"AUTH"},"plugin":"unexpected"}`} {
		if _, err := Validate(json.RawMessage(raw)); err == nil {
			t.Fatal("accepted invalid config")
		}
	}
}

func routineEndpoint(t *testing.T) model.EndpointConfig {
	t.Helper()
	return model.EndpointConfig{ID: "grok-A", Agent: model.Grok, Config: json.RawMessage(`{"mcp":{"token":{"env":"GROK_MCP"}},"routineUrl":{"env":"GROK_ROUTINE"},"routineAuthorization":{"env":"GROK_AUTH"}}`)}
}

func routineInput(endpoint model.EndpointConfig) model.DispatchInput {
	return model.DispatchInput{Request: model.InboundSnapshot{RequestID: "request-first", AcceptedAt: time.Date(2026, 10, 17, 1, 2, 3, 4000000, time.UTC), Endpoint: endpoint, Channel: model.ChannelAddress{ID: "authorized-channel", Platform: model.Telegram, AccountID: "account-1", ChatID: "native-chat-9001"}, SenderID: "sender-7", Text: "message", Context: json.RawMessage(`{"native_id":"9001"}`), Attachments: []model.MediaReference{{ID: "media-native", Kind: model.Image, MIMEType: "image/png", FileName: "a.png", Size: 3, SHA256: "native-digest"}}}}
}
