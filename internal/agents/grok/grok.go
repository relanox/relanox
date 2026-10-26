// Package grok connects a configured hosted Routine and its scoped MCP endpoint.
package grok

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

type Config struct {
	MCP                  agentmcp.Config `json:"mcp"`
	RoutineURL           model.SecretRef `json:"routineUrl"`
	RoutineAuthorization model.SecretRef `json:"routineAuthorization"`
}

func Validate(raw json.RawMessage) (Config, error) {
	var c Config
	if err := agentmcp.Decode(raw, &c); err != nil {
		return c, err
	}
	if err := c.MCP.Validate("bearer", "path"); err != nil {
		return c, err
	}
	if err := config.ValidateSecretRef(c.RoutineURL, "routineUrl"); err != nil {
		return c, err
	}
	return c, config.ValidateSecretRef(c.RoutineAuthorization, "routineAuthorization")
}

type Agent struct {
	endpoint model.EndpointConfig
	deps     agentmcp.Dependencies
}

func New(endpoint model.EndpointConfig, deps agentmcp.Dependencies) (*Agent, error) {
	if endpoint.Agent != model.Grok {
		return nil, errors.New("invalid_agent_kind")
	}
	c, err := Validate(endpoint.Config)
	if err != nil {
		return nil, err
	}
	_, err = agentmcp.New(agentmcp.Options{Endpoint: endpoint, Config: c.MCP, Dependencies: deps})
	if err != nil {
		return nil, err
	}
	return &Agent{endpoint: endpoint, deps: deps}, nil
}

func (a *Agent) Kind() model.AgentKind { return model.Grok }

func (a *Agent) Start(context.Context) error {
	a.deps.Host.Connection(model.Connected, "")
	return nil
}

func (a *Agent) Close(context.Context) error { return nil }

func (a *Agent) Dispatch(ctx context.Context, in model.DispatchInput) (model.DispatchResult, error) {
	if in.Request.Endpoint.ID != a.endpoint.ID || in.Request.Endpoint.Agent != model.Grok {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "grok_endpoint_invalid"}, nil
	}
	c, err := Validate(in.Request.Endpoint.Config)
	if err != nil {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "grok_config_invalid"}, nil
	}
	value, err := a.deps.Secret(c.RoutineURL)
	if err != nil {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "grok_credentials_invalid"}, nil
	}
	endpoint, err := url.Parse(value)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "grok_routine_url_invalid"}, nil
	}
	authorization, err := a.deps.Secret(c.RoutineAuthorization)
	if err != nil {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "grok_credentials_invalid"}, nil
	}
	payload, err := json.Marshal(agentmcp.Notification(in))
	if err != nil {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "grok_body_invalid"}, nil
	}
	body, err := json.Marshal(map[string]any{"content": string(payload), "source": "relanox", "sentAt": in.Request.AcceptedAt.UTC().Format("2006-01-02T15:04:05.000Z")})
	if err != nil || len(body) > 1<<20 {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "grok_body_too_large"}, nil
	}
	if ctx.Err() != nil {
		return model.DispatchResult{Status: model.Retryable, ErrorCode: "grok_dispatch_cancelled"}, nil
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(bounded, "POST", endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "grok_request_invalid"}, nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authorization)
	client := *a.deps.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return model.DispatchResult{Status: model.Unknown, ErrorCode: "grok_trigger_uncertain"}, nil
	}
	// The HTTP receipt determines dispatch outcome, not connection cleanup.
	defer func() { _ = resp.Body.Close() }()
	return classifyReceipt(resp), nil
}

func classifyReceipt(response *http.Response) model.DispatchResult {
	status := response.StatusCode
	// Cursor documents 200 as the sole acknowledgement that a Routine started.
	// https://cursor.com/help/grok-bot/routines#where-do-the-webhook-url-and-key-live-and-what-does-a-200-mean
	if status == http.StatusOK {
		return model.DispatchResult{Status: model.Accepted}
	}
	result := model.DispatchResult{Status: model.Rejected, ErrorCode: "grok_http_" + strconv.Itoa(status)}
	if status == 408 {
		result.Status = model.Unknown
		return result
	}
	if status != 429 && status < 500 {
		return result
	}
	result.Status = model.Retryable
	value := response.Header.Get("Retry-After")
	if seconds, err := strconv.ParseUint(value, 10, 32); err == nil {
		result.RetryAfter = min(time.Duration(seconds)*time.Second, time.Hour)
	} else if when, err := http.ParseTime(value); err == nil {
		result.RetryAfter = max(0, min(time.Until(when), time.Hour))
	}
	return result
}

var _ model.Agent = (*Agent)(nil)
