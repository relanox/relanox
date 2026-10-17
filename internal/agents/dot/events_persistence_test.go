package dot

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/model"
)

// A real callback TLS peer and real SQLite state protect subscription
// verification, signing-key overlap, persistence, ownership and dispatch outcome
// classification. An owner fingerprint/CAS regression could notify a reassigned
// endpoint; a receipt regression could replay uncertain remote effects. The
// earlier pure crypto tests do not exercise native Events or persisted state.
func TestPersistedEventsVerifyRotateAndClassifyNativeCallbacks(t *testing.T) {
	h := newOAuthHarness(t)
	callback := newCallbackPeer(t)
	h.callbackClient = callback.client
	h.reopen(t)
	clientID, code := h.authorize(t)
	status, data := h.form(t, "/agents/dot/oauth/endpoint-A/token", h.codeForm(clientID, code), "")
	if status != 200 {
		t.Fatal(status, string(data))
	}
	token := decodeTokens(t, data).Access
	secret := "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
	params := subscriptionParams(secret)
	receiptData := h.eventCall(t, token, "events/subscribe", params)
	var receipt subscriptionResult
	if json.Unmarshal(receiptData, &receipt) != nil || receipt.ID == "" || receipt.Truncated || receipt.Cursor != nil {
		t.Fatalf("invalid native subscription receipt %s", receiptData)
	}
	expiry, parseErr := time.Parse(time.RFC3339Nano, receipt.RefreshBefore)
	if parseErr != nil || time.Until(expiry) > 24*time.Hour || time.Until(expiry) < 23*time.Hour {
		t.Fatal("native subscription TTL was not capped before duration conversion")
	}
	if callback.challenges.Load() != 1 {
		t.Fatal("callback was not verified")
	}
	h.eventCall(t, token, "events/subscribe", params)
	if callback.challenges.Load() != 1 {
		t.Fatal("fresh verified subscription was challenged twice")
	}
	rotated := "whsec_" + base64.StdEncoding.EncodeToString([]byte(strings.Repeat("r", 24)))
	params = subscriptionParams(rotated)
	h.eventCall(t, token, "events/subscribe", params)
	if callback.challenges.Load() != 2 || callback.signatureCount.Load() != 2 {
		t.Fatal("key rotation lost challenge or old/new overlap")
	}
	h.reopen(t)
	a := h.agents["endpoint-A"]
	in := eventInput(a.endpoint)
	for _, row := range []struct {
		status int
		want   model.Outcome
	}{{202, model.Accepted}, {408, model.Unknown}, {429, model.Retryable}, {503, model.Retryable}, {410, model.Rejected}} {
		callback.status.Store(int32(row.status))
		result, err := a.Dispatch(context.Background(), in)
		if err != nil || result.Status != row.want {
			t.Fatal(row.status, result, err)
		}
	}
	if callback.events.Load() != 5 {
		t.Fatal("lost independent callback dispatch")
	}
	if callback.invalidEvent.Load() {
		t.Fatal("event payload or headers did not match native contract")
	}
	result, err := a.Dispatch(context.Background(), in)
	if err != nil || result.Status != model.Retryable || result.ErrorCode != "dot_no_active_subscription" {
		t.Fatal("410 did not retire subscription", result, err)
	}
}

func TestAuthenticatedDotDiscoveryRetainsEventsAndFileToolMetadata(t *testing.T) {
	h := newOAuthHarness(t)
	clientID, code := h.authorize(t)
	status, data := h.form(t, "/agents/dot/oauth/endpoint-A/token", h.codeForm(clientID, code), "")
	if status != 200 {
		t.Fatal(status)
	}
	token := decodeTokens(t, data).Access
	data = h.eventCall(t, token, "server/discover", map[string]any{})
	var discovery struct {
		Capabilities map[string]json.RawMessage `json:"capabilities"`
	}
	if json.Unmarshal(data, &discovery) != nil || discovery.Capabilities["events"] == nil {
		t.Fatalf("native Events capability missing: %s", data)
	}
	data = h.eventCall(t, token, "tools/list", map[string]any{})
	var tools struct {
		Tools []struct {
			Name            string `json:"name"`
			SecuritySchemes []struct {
				Type   string   `json:"type"`
				Scopes []string `json:"scopes"`
			} `json:"securitySchemes"`
			Meta         map[string]json.RawMessage `json:"_meta"`
			OutputSchema json.RawMessage            `json:"outputSchema"`
		} `json:"tools"`
	}
	if json.Unmarshal(data, &tools) != nil || len(tools.Tools) < 3 {
		t.Fatalf("missing tool discovery %s", data)
	}
	for _, tool := range tools.Tools {
		if len(tool.SecuritySchemes) != 1 || tool.SecuritySchemes[0].Type != "oauth2" || len(tool.SecuritySchemes[0].Scopes) != 1 || tool.SecuritySchemes[0].Scopes[0] != "relanox" || tool.Meta["securitySchemes"] == nil {
			t.Fatalf("OAuth tool metadata missing: %s", data)
		}
		if len(tool.OutputSchema) == 0 {
			t.Fatalf("typed output schema missing for %s", tool.Name)
		}
		if tool.Name == "relanox_send_message" {
			var files []string
			if json.Unmarshal(tool.Meta["openai/fileParams"], &files) != nil || len(files) != 1 || files[0] != "files" {
				t.Fatal("native dot file parameter metadata lost")
			}
		}
	}
}

func TestSubscriptionConfigurationOwnershipSurvivesReopen(t *testing.T) {
	h := newOAuthHarness(t)
	callback := newCallbackPeer(t)
	h.callbackClient = callback.client
	h.reopen(t)
	clientID, code := h.authorize(t)
	status, data := h.form(t, "/agents/dot/oauth/endpoint-A/token", h.codeForm(clientID, code), "")
	if status != 200 {
		t.Fatal(status)
	}
	token := decodeTokens(t, data).Access
	params := subscriptionParams("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")
	h.eventCall(t, token, "events/subscribe", params)
	old := eventInput(h.agents["endpoint-A"].endpoint)
	t.Setenv("DOT_OTHER_PASSWORD", h.password)
	h.secretEnv = "DOT_OTHER_PASSWORD"
	h.reopen(t)
	a := h.agents["endpoint-A"]
	result, err := a.Dispatch(context.Background(), old)
	if err != nil || result.Status != model.Rejected || result.ErrorCode != "dot_endpoint_revoked" {
		t.Fatal("captured prior endpoint was not revoked", result, err)
	}
	result, err = a.Dispatch(context.Background(), eventInput(a.endpoint))
	if err != nil || result.Status != model.Retryable {
		t.Fatal("old owner subscription remained active", result, err)
	}
	if callback.events.Load() != 0 {
		t.Fatal("notified an inactive prior-owner subscription")
	}
	h.eventCall(t, token, "events/subscribe", params)
	if callback.challenges.Load() != 2 {
		t.Fatal("changed ownership reused prior verification")
	}
	result, err = a.Dispatch(context.Background(), eventInput(a.endpoint))
	if err != nil || result.Status != model.Accepted {
		t.Fatal("refreshed native subscription failed", result, err)
	}
	if callback.events.Load() != 1 {
		t.Fatal("refreshed owner was not notified")
	}
}

func subscriptionParams(secret string) map[string]any {
	return map[string]any{"name": eventName, "arguments": map[string]any{}, "delivery": map[string]any{"mode": "webhook", "url": "https://connectors.api.openai.com/native-callback", "secret": secret}, "cursor": nil, "ttlMs": int64(9007199254740991)}
}

func (h *oauthHarness) eventCall(t *testing.T, token, method string, params map[string]any) json.RawMessage {
	t.Helper()
	params["_meta"] = map[string]any{"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": map[string]any{}}
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "native-rpc", "method": method, "params": params})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest("POST", h.origin+"/agents/dot/mcp/endpoint-A", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("MCP-Protocol-Version", "2026-07-28")
	request.Header.Set("Mcp-Method", method)
	status, data := h.do(t, request)
	var response struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if status != 200 || json.Unmarshal(data, &response) != nil || len(response.Result) == 0 {
		t.Fatalf("native Events failed %d %s", status, data)
	}
	return response.Result
}

type callbackPeer struct {
	client                                     *http.Client
	challenges, events, status, signatureCount atomic.Int32
	invalidEvent                               atomic.Bool
}

func newCallbackPeer(t *testing.T) *callbackPeer {
	t.Helper()
	peer := &callbackPeer{}
	peer.status.Store(202)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		if err != nil {
			peer.invalidEvent.Store(true)
			w.WriteHeader(400)
			return
		}
		if r.Method != "POST" || r.Host != "connectors.api.openai.com" || r.Header.Get("webhook-id") == "" || r.Header.Get("webhook-timestamp") == "" || r.Header.Get("X-MCP-Subscription-Id") == "" {
			peer.invalidEvent.Store(true)
		}
		peer.signatureCount.Store(int32(len(strings.Fields(r.Header.Get("webhook-signature")))))
		var body struct {
			Type      string `json:"type"`
			Challenge string `json:"challenge"`
			EventID   string `json:"eventId"`
			Name      string `json:"name"`
			Data      struct {
				RequestID  string `json:"requestId"`
				AcceptedAt int64  `json:"acceptedAt"`
				Text       string `json:"text"`
				Source     struct {
					Channel  model.ChannelAddress `json:"channel"`
					SenderID string               `json:"senderId"`
				} `json:"source"`
			} `json:"data"`
		}
		if json.Unmarshal(data, &body) != nil {
			peer.invalidEvent.Store(true)
			w.WriteHeader(400)
			return
		}
		if body.Type == "verification" {
			peer.challenges.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"challenge": body.Challenge})
			return
		}
		peer.events.Add(1)
		if body.Name != eventName || body.EventID != "evt_request-native" || r.Header.Get("webhook-id") != body.EventID || body.Data.RequestID != "request-native" || body.Data.AcceptedAt != 1792198923004 || body.Data.Source.Channel.ID != "channel-native" || body.Data.Source.Channel.ChatID != "chat-native" || body.Data.Source.SenderID != "sender-native" || body.Data.Text != "message-native" {
			peer.invalidEvent.Store(true)
		}
		w.WriteHeader(int(peer.status.Load()))
	}))
	t.Cleanup(server.Close)
	remote, _ := url.Parse(server.URL)
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = remote.Hostname()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, remote.Host)
	}
	peer.client = &http.Client{Transport: transport}
	t.Cleanup(transport.CloseIdleConnections)
	return peer
}

func eventInput(endpoint model.EndpointConfig) model.DispatchInput {
	return model.DispatchInput{Request: model.InboundSnapshot{RequestID: "request-native", AcceptedAt: time.Date(2026, 10, 17, 1, 2, 3, 4000000, time.UTC), Text: "message-native", Context: json.RawMessage(`{"native":"value"}`), Endpoint: endpoint, Channel: model.ChannelAddress{ID: "channel-native", Platform: model.Telegram, AccountID: "account-native", ChatID: "chat-native"}, SenderID: "sender-native"}}
}
