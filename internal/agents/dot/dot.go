// Package dot implements native ChatGPT OAuth, MCP Events and message tools.
package dot

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/model"
)

type Config struct {
	MCP agentmcp.Config `json:"mcp"`
}

func Validate(raw json.RawMessage) (Config, error) {
	var c Config
	if err := agentmcp.Decode(raw, &c); err != nil {
		return c, err
	}
	err := c.MCP.Validate("oauth")
	return c, err
}

type Agent struct {
	endpoint    model.EndpointConfig
	deps        agentmcp.Dependencies
	mcp         *agentmcp.Server
	ownerConfig string
}

func New(endpoint model.EndpointConfig, deps agentmcp.Dependencies) (*Agent, error) {
	if endpoint.Agent != model.Dot || deps.Host == nil {
		return nil, errors.New("invalid_agent_kind")
	}
	c, err := Validate(endpoint.Config)
	if err != nil {
		return nil, err
	}
	a := &Agent{endpoint: endpoint, deps: deps, ownerConfig: fingerprint(endpoint)}
	oauth, err := newOAuth(endpoint, c.MCP, deps)
	if err != nil {
		return nil, err
	}
	a.mcp, err = agentmcp.New(agentmcp.Options{Endpoint: endpoint, Config: c.MCP, Dependencies: deps, ModernOnly: true, Authenticate: oauth.authenticate, Configure: a.configureEvents, StatusContext: a.connectionStatus})
	if err != nil {
		return nil, err
	}
	return a, nil
}

func (a *Agent) Kind() model.AgentKind { return model.Dot }

func (a *Agent) Start(ctx context.Context) error {
	a.deps.Host.Connection(model.Connected, "")
	return a.mcp.Start(ctx)
}

func (a *Agent) Close(ctx context.Context) error { return a.mcp.Close(ctx) }

func (a *Agent) connectionStatus(ctx context.Context) (map[string]any, error) {
	entries, err := a.activeEntries(ctx)
	if err != nil {
		return nil, err
	}
	count := 0
	for _, entry := range entries {
		var sub subscription
		if json.Unmarshal(entry.Value, &sub) == nil && a.currentSubscription(sub) {
			count++
		}
	}
	return map[string]any{"endpointId": a.endpoint.ID, "eventName": eventName, "activeSubscriptions": count}, nil
}

func (a *Agent) currentSubscription(sub subscription) bool {
	return sub.Owner == a.endpoint.ID && sub.EndpointID == a.endpoint.ID && sub.OwnerConfig == a.ownerConfig && sub.ExpiresAt > time.Now().UnixMilli()
}

func (a *Agent) Dispatch(ctx context.Context, in model.DispatchInput) (model.DispatchResult, error) {
	if in.Request.Endpoint.ID != a.endpoint.ID || in.Request.Endpoint.Agent != model.Dot || fingerprint(in.Request.Endpoint) != a.ownerConfig {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "dot_endpoint_revoked"}, nil
	}
	entries, err := a.activeEntries(ctx)
	if err != nil {
		return model.DispatchResult{Status: model.Retryable, ErrorCode: "dot_subscription_unavailable"}, nil
	}
	eventID := "evt_" + in.Request.RequestID
	data := agentmcp.Notification(in)
	data["acceptedAt"] = in.Request.AcceptedAt.UnixMilli()
	body, err := json.Marshal(map[string]any{"eventId": eventID, "name": eventName, "timestamp": in.Request.AcceptedAt.UTC().Format("2006-01-02T15:04:05.000Z"), "data": data, "cursor": nil})
	if err != nil || len(body) > 262144 {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "dot_event_too_large"}, nil
	}
	outcome := model.DispatchResult{Status: model.Accepted}
	active := false
	for _, entry := range entries {
		var sub subscription
		if json.Unmarshal(entry.Value, &sub) != nil || !a.currentSubscription(sub) {
			continue
		}
		active = true
		result := a.dispatchSubscription(ctx, entry, sub, eventID, body)
		if dispatchPriority(result.Status) > dispatchPriority(outcome.Status) {
			outcome = result
		}
	}
	if !active {
		return model.DispatchResult{Status: model.Retryable, ErrorCode: "dot_no_active_subscription"}, nil
	}
	return outcome, nil
}

func (a *Agent) dispatchSubscription(ctx context.Context, entry model.StateEntry, sub subscription, eventID string, body []byte) model.DispatchResult {
	if _, err := callbackURL(sub.URL); err != nil {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "dot_callback_forbidden"}
	}
	status, _, err := postCallback(ctx, a.deps, sub, eventID, body, false)
	if err != nil {
		return model.DispatchResult{Status: model.Unknown, ErrorCode: "dot_callback_uncertain"}
	}
	if status >= 200 && status < 300 {
		return model.DispatchResult{Status: model.Accepted}
	}
	if status == 408 {
		return model.DispatchResult{Status: model.Unknown, ErrorCode: "dot_callback_http_408"}
	}
	result := model.DispatchResult{Status: model.Retryable, ErrorCode: "dot_callback_http_" + strconv.Itoa(status)}
	if status == 410 || status == 413 || status >= 300 && status < 500 && status != 429 {
		result.Status = model.Rejected
		if status == 410 {
			_, _ = a.deps.Host.State().Delete(ctx, entry.Key, entry.Version)
		}
	}
	return result
}

func dispatchPriority(outcome model.Outcome) int {
	switch outcome {
	case model.Rejected:
		return 1
	case model.Retryable:
		return 2
	case model.Unknown:
		return 3
	}
	return 0
}

var _ model.Agent = (*Agent)(nil)
