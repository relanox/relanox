package dot

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/relanox/relanox/internal/agentmcp"
)

type emptyArguments struct{}

type subscribeParams struct {
	mcp.ParamsBase
	Name      string          `json:"name"`
	Arguments *emptyArguments `json:"arguments"`
	Delivery  struct {
		Mode   string `json:"mode"`
		URL    string `json:"url"`
		Secret string `json:"secret"`
	} `json:"delivery"`
	Cursor json.RawMessage `json:"cursor,omitempty"`
	TTLMS  *int64          `json:"ttlMs,omitempty"`
}

type unsubscribeParams struct {
	mcp.ParamsBase
	Name      string          `json:"name"`
	Arguments *emptyArguments `json:"arguments"`
	Delivery  struct {
		Mode string `json:"mode"`
		URL  string `json:"url"`
	} `json:"delivery"`
}

type eventListParams struct {
	mcp.ParamsBase
	Cursor json.RawMessage `json:"cursor,omitempty"`
}

type subscriptionResult struct {
	mcp.ResultBase
	ID            string `json:"id"`
	RefreshBefore string `json:"refreshBefore"`
	Cursor        any    `json:"cursor"`
	Truncated     bool   `json:"truncated"`
}

type eventListResult struct {
	mcp.ResultBase
	Events []map[string]any `json:"events"`
}

type emptyResult struct{ mcp.ResultBase }

func (p *subscribeParams) UnmarshalJSON(data []byte) error {
	type plain subscribeParams
	return agentmcp.Decode(data, (*plain)(p))
}

func (p *unsubscribeParams) UnmarshalJSON(data []byte) error {
	type plain unsubscribeParams
	return agentmcp.Decode(data, (*plain)(p))
}

func (p *eventListParams) UnmarshalJSON(data []byte) error {
	type plain eventListParams
	return agentmcp.Decode(data, (*plain)(p))
}

func (p *subscribeParams) validate() error {
	if p.Name != eventName || p.Arguments == nil || p.Delivery.Mode != "webhook" || len(p.Cursor) > 0 && !bytes.Equal(p.Cursor, []byte("null")) || p.TTLMS != nil && (*p.TTLMS < 1000 || *p.TTLMS > 1<<53-1) {
		return &jsonrpc.Error{Code: -32602, Message: "Invalid subscription parameters"}
	}
	if _, err := webhookSignature(p.Delivery.Secret, "validation", "0", nil); err != nil {
		return &jsonrpc.Error{Code: -32602, Message: "Invalid signing secret"}
	}
	return nil
}

func (a *Agent) configureEvents(server *mcp.Server) error {
	if err := mcp.AddReceivingCustomMethod(server, "events/list", func(_ context.Context, _ *mcp.ServerSession, params *eventListParams) (*eventListResult, error) {
		if len(params.Cursor) > 0 && !bytes.Equal(params.Cursor, []byte("null")) {
			return nil, &jsonrpc.Error{Code: -32602, Message: "Invalid cursor"}
		}
		return &eventListResult{Events: []map[string]any{{"name": eventName, "description": "A persisted incoming message is available in this authenticated endpoint; data contains the complete message.", "delivery": []string{"webhook"}, "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}, "payloadSchema": incomingSchema()}}}, nil
	}); err != nil {
		return err
	}
	if err := mcp.AddReceivingCustomMethod(server, "events/subscribe", func(ctx context.Context, _ *mcp.ServerSession, params *subscribeParams) (*subscriptionResult, error) {
		return a.subscribe(ctx, params)
	}); err != nil {
		return err
	}
	return mcp.AddReceivingCustomMethod(server, "events/unsubscribe", func(ctx context.Context, _ *mcp.ServerSession, params *unsubscribeParams) (*emptyResult, error) {
		return a.unsubscribe(ctx, params)
	})
}

func incomingSchema() map[string]any { return agentmcp.IncomingSchema(false) }
