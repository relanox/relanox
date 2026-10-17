package core

import (
	"context"
	"encoding/json"
	"time"

	"github.com/relanox/relanox/internal/model"
)

func (r *Runtime) Health(ctx context.Context) (model.Health, error) { return r.store.Health(ctx) }

func (r *Runtime) Stats(ctx context.Context) (model.StorageStats, error) { return r.store.Stats(ctx) }

func (r *Runtime) Requeue(ctx context.Context, input model.RequeueInput) (model.MutationResult, error) {
	return r.store.Requeue(ctx, input)
}

func (r *Runtime) Cleanup(ctx context.Context, input model.CleanupInput) (int64, error) {
	return r.store.Cleanup(ctx, input)
}

func (r *Runtime) Connections() map[string]model.ConnectionStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()
	statuses := make(map[string]model.ConnectionStatus, len(r.connections))
	for id, status := range r.connections {
		statuses[id] = status
	}
	return statuses
}

func discoveryNamespace(account string) model.StateNamespace {
	return model.StateNamespace{Component: "core:discovery", OwnerID: account}
}

// Discoveries returns authenticated native addresses for the CLI's bind flow.
// Discovering an address does not authorize it for acceptance or sending.
func (r *Runtime) Discoveries(ctx context.Context, accountID string, limit int) ([]model.DiscoveredConversation, error) {
	if _, ok := r.accounts[accountID]; !ok {
		return nil, failure("unknown_account")
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 1000 {
		return nil, failure("invalid_discovery_limit")
	}
	entries, err := r.store.ListState(ctx, discoveryNamespace(accountID), model.ListStateInput{Limit: limit})
	if err != nil {
		return nil, err
	}
	conversations := make([]model.DiscoveredConversation, 0, len(entries))
	for _, entry := range entries {
		if entry.ExpiresAt != nil && !entry.ExpiresAt.After(time.Now()) {
			continue
		}
		var conversation model.DiscoveredConversation
		if json.Unmarshal(entry.Value, &conversation) == nil {
			conversations = append(conversations, conversation)
		}
	}
	return conversations, nil
}

func (h *channelHost) rememberDiscovery(ctx context.Context, input model.DiscoveredConversation) error {
	namespace := discoveryNamespace(h.account.ID)
	key := fingerprint(input)
	value, _ := json.Marshal(input)
	for range 8 {
		previous, err := h.runtime.store.GetState(ctx, namespace, key)
		if err != nil {
			return err
		}
		expires := time.Now().Add(30 * 24 * time.Hour)
		entry := model.CompareAndSetStateInput{Key: key, Value: value, ExpiresAt: &expires}
		if previous != nil {
			entry.ExpectedVersion = &previous.Version
		}
		result, err := h.runtime.store.CompareAndSetState(ctx, namespace, entry)
		if err != nil {
			return err
		}
		if result.Status == model.Updated {
			return nil
		}
	}
	return failure("discovery_write_conflict")
}
