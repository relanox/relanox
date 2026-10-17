package dot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/model"
)

const eventName = "relanox.message_available"

type subscription struct {
	ID             string         `json:"id"`
	Owner          string         `json:"owner"`
	EndpointID     string         `json:"endpointId"`
	OwnerConfig    string         `json:"ownerConfig"`
	Name           string         `json:"name"`
	Arguments      map[string]any `json:"arguments"`
	URL            string         `json:"url"`
	Secret         string         `json:"secret"`
	ExpiresAt      int64          `json:"expiresAt"`
	VerifiedAt     int64          `json:"verifiedAt"`
	PreviousSecret string         `json:"previousSecret,omitempty"`
	PreviousUntil  int64          `json:"previousUntil,omitempty"`
}

func canonical(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var object any
	if json.Unmarshal(raw, &object) != nil {
		return nil, errors.New("invalid_json")
	}
	return json.Marshal(object)
}

func hashIdentity(value any) string {
	data, err := canonical(value)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func fingerprint(endpoint model.EndpointConfig) string {
	c, err := Validate(endpoint.Config)
	if err != nil {
		return ""
	}
	return hashIdentity(map[string]any{"agent": endpoint.Agent, "config": c})
}

func subscriptionID(owner, url string) string {
	return "sub_" + hashIdentity(map[string]any{"owner": owner, "url": url, "name": eventName, "arguments": map[string]any{}})
}

func callbackFailure(reason string) error {
	data, _ := json.Marshal(map[string]string{"reason": reason})
	return &jsonrpc.Error{Code: -32015, Message: "CallbackEndpointError", Data: data}
}

func (a *Agent) activeEntries(ctx context.Context) ([]model.StateEntry, error) {
	return a.deps.Host.State().List(ctx, model.ListStateInput{Prefix: "subscriptions/" + a.endpoint.ID + "/", Limit: 1000})
}

func (a *Agent) subscribe(ctx context.Context, input *subscribeParams) (*subscriptionResult, error) {
	if err := input.validate(); err != nil {
		return nil, err
	}
	destination, err := callbackURL(input.Delivery.URL)
	if err != nil {
		return nil, callbackFailure("forbidden_destination")
	}
	id := subscriptionID(a.endpoint.ID, destination)
	key := "subscriptions/" + a.endpoint.ID + "/" + id
	state := a.deps.Host.State()
	entry, err := state.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	old, err := a.previousOwnedSubscription(entry)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	ttl := 24 * time.Hour
	if input.TTLMS != nil {
		ttl = time.Duration(min(*input.TTLMS, int64(ttl/time.Millisecond))) * time.Millisecond
	}
	sub := subscription{ID: id, Owner: a.endpoint.ID, EndpointID: a.endpoint.ID, OwnerConfig: a.ownerConfig, Name: eventName, Arguments: map[string]any{}, URL: destination, Secret: input.Delivery.Secret, ExpiresAt: now.Add(ttl).UnixMilli(), VerifiedAt: now.UnixMilli()}
	applySigningKeyOverlap(&sub, old, now)
	if old.ID == "" || old.ExpiresAt <= now.UnixMilli() || old.Secret != sub.Secret || now.UnixMilli()-old.VerifiedAt > 60000 {
		if err = a.verifySubscription(ctx, sub); err != nil {
			return nil, err
		}
	} else {
		sub.VerifiedAt = old.VerifiedAt
	}
	if entry == nil {
		if err = a.checkCapacity(ctx); err != nil {
			return nil, err
		}
	}
	encoded, err := json.Marshal(sub)
	if err != nil {
		return nil, err
	}
	expires := time.UnixMilli(sub.ExpiresAt)
	mutation := model.CompareAndSetStateInput{Key: key, Value: encoded, ExpiresAt: &expires}
	if entry != nil {
		mutation.ExpectedVersion = &entry.Version
	}
	result, err := state.CompareAndSet(ctx, mutation)
	if err != nil {
		return nil, err
	}
	if result.Status != model.Updated {
		return nil, &jsonrpc.Error{Code: -32000, Message: "subscription_conflict"}
	}
	return &subscriptionResult{ID: id, RefreshBefore: expires.UTC().Format(time.RFC3339Nano)}, nil
}

func (a *Agent) previousOwnedSubscription(entry *model.StateEntry) (subscription, error) {
	if entry == nil {
		return subscription{}, nil
	}
	var previous subscription
	if json.Unmarshal(entry.Value, &previous) != nil {
		return subscription{}, errors.New("invalid_subscription_state")
	}
	if previous.OwnerConfig != a.ownerConfig {
		return subscription{}, nil
	}
	return previous, nil
}

func applySigningKeyOverlap(sub *subscription, old subscription, now time.Time) {
	if old.ID != "" && old.Secret != sub.Secret {
		sub.PreviousSecret = old.Secret
		sub.PreviousUntil = now.Add(time.Minute).UnixMilli()
		return
	}
	if old.PreviousSecret != "" && old.PreviousUntil > now.UnixMilli() {
		sub.PreviousSecret = old.PreviousSecret
		sub.PreviousUntil = old.PreviousUntil
	}
}

func (a *Agent) verifySubscription(ctx context.Context, sub subscription) error {
	challenge := agentmcp.Opaque()
	body, _ := json.Marshal(map[string]string{"type": "verification", "challenge": challenge})
	status, data, err := postCallback(ctx, a.deps, sub, "verification_"+agentmcp.UUID(), body, true)
	if err != nil {
		return callbackFailure("challenge_failed")
	}
	var echoed struct {
		Challenge string `json:"challenge"`
	}
	if status < 200 || status >= 300 || agentmcp.Decode(data, &echoed) != nil || !agentmcp.EqualSecret(challenge, echoed.Challenge) {
		return callbackFailure("challenge_failed")
	}
	return nil
}

func (a *Agent) checkCapacity(ctx context.Context) error {
	entries, err := a.activeEntries(ctx)
	if err != nil {
		return err
	}
	active := 0
	for _, entry := range entries {
		if entry.ExpiresAt != nil && !entry.ExpiresAt.After(time.Now()) {
			if _, err = a.deps.Host.State().Delete(ctx, entry.Key, entry.Version); err != nil {
				return err
			}
		} else {
			active++
		}
	}
	if active >= 100 {
		return &jsonrpc.Error{Code: -32000, Message: "subscription_limit"}
	}
	return nil
}

func (a *Agent) unsubscribe(ctx context.Context, input *unsubscribeParams) (*emptyResult, error) {
	if input.Name != eventName || input.Arguments == nil || input.Delivery.Mode != "webhook" {
		return nil, &jsonrpc.Error{Code: -32602, Message: "Invalid subscription parameters"}
	}
	destination, err := callbackURL(input.Delivery.URL)
	if err != nil {
		return nil, callbackFailure("forbidden_destination")
	}
	key := "subscriptions/" + a.endpoint.ID + "/" + subscriptionID(a.endpoint.ID, destination)
	state := a.deps.Host.State()
	entry, err := state.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	if entry == nil {
		return &emptyResult{}, nil
	}
	var sub subscription
	if json.Unmarshal(entry.Value, &sub) != nil {
		return nil, errors.New("invalid_subscription_state")
	}
	if sub.OwnerConfig != a.ownerConfig {
		return &emptyResult{}, nil
	}
	result, err := state.Delete(ctx, key, entry.Version)
	if err != nil {
		return nil, err
	}
	if result.Status != model.Updated {
		return nil, &jsonrpc.Error{Code: -32000, Message: "subscription_conflict"}
	}
	return &emptyResult{}, nil
}
