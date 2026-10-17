// Package muse notifies paired Muse devices and exposes their scoped MCP tools.
package muse

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/musewire"
)

type Config struct {
	MCP                  agentmcp.Config `json:"mcp"`
	CredentialsDirectory model.SecretRef `json:"credentialsDirectory"`
	VMID                 string          `json:"vmId,omitempty"`
	SessionID            string          `json:"sessionId,omitempty"`
}

func Validate(raw json.RawMessage) (Config, error) {
	var c Config
	if err := agentmcp.Decode(raw, &c); err != nil {
		return c, err
	}
	if err := c.MCP.Validate("bearer", "path"); err != nil {
		return c, err
	}
	if len(c.VMID) > 1024 || len(c.SessionID) > 1024 {
		return c, errors.New("invalid_muse_identifier")
	}
	return c, config.ValidateSecretRef(c.CredentialsDirectory, "credentialsDirectory")
}

type Agent struct {
	endpoint model.EndpointConfig
	deps     agentmcp.Dependencies
	mcp      *agentmcp.Server
}

func New(endpoint model.EndpointConfig, deps agentmcp.Dependencies) (*Agent, error) {
	if endpoint.Agent != model.Muse {
		return nil, errors.New("invalid_agent_kind")
	}
	c, err := Validate(endpoint.Config)
	if err != nil {
		return nil, err
	}
	server, err := agentmcp.New(agentmcp.Options{Endpoint: endpoint, Config: c.MCP, Dependencies: deps})
	if err != nil {
		return nil, err
	}
	return &Agent{endpoint: endpoint, deps: deps, mcp: server}, nil
}

func (a *Agent) Kind() model.AgentKind { return model.Muse }

func (a *Agent) Start(ctx context.Context) error {
	a.deps.Host.Connection(model.Connected, "")
	return a.mcp.Start(ctx)
}

func (a *Agent) Close(ctx context.Context) error { return a.mcp.Close(ctx) }

func (a *Agent) Dispatch(ctx context.Context, in model.DispatchInput) (model.DispatchResult, error) {
	if in.Request.Endpoint.ID != a.endpoint.ID || in.Request.Endpoint.Agent != model.Muse {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "muse_endpoint_invalid"}, nil
	}
	c, err := Validate(in.Request.Endpoint.Config)
	if err != nil {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "muse_config_invalid"}, nil
	}
	directory, err := a.deps.Secret(c.CredentialsDirectory)
	if err != nil {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "muse_credentials_invalid"}, nil
	}
	if a.deps.ResolvePath != nil {
		directory = a.deps.ResolvePath(directory)
	} else {
		directory, err = filepath.Abs(directory)
		if err != nil {
			return model.DispatchResult{Status: model.Rejected, ErrorCode: "muse_credentials_invalid"}, nil
		}
	}
	content, err := json.Marshal(agentmcp.Notification(in))
	if err != nil {
		return model.DispatchResult{Status: model.Rejected, ErrorCode: "muse_body_invalid"}, nil
	}
	_, err = musewire.SendMessage(ctx, musewire.Options{CredentialsDirectory: directory, VMID: c.VMID, SessionID: c.SessionID, HTTPClient: a.deps.HTTPClient}, string(content))
	if err == nil {
		return model.DispatchResult{Status: model.Accepted}, nil
	}
	var failure *musewire.Error
	if errors.As(err, &failure) {
		if failure.Sent {
			return model.DispatchResult{Status: model.Unknown, ErrorCode: "muse_trigger_uncertain"}, nil
		}
		if failure.Stage == "credentials" || failure.Stage == "configuration" || failure.Stage == "body" {
			return model.DispatchResult{Status: model.Rejected, ErrorCode: "muse_" + failure.Stage + "_invalid"}, nil
		}
	}
	return model.DispatchResult{Status: model.Retryable, ErrorCode: "muse_connect_failed"}, nil
}

var _ model.Agent = (*Agent)(nil)
