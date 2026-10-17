package storage

import (
	"context"

	"github.com/relanox/relanox/internal/model"
)

type namespaceState struct {
	store     *Store
	namespace model.StateNamespace
}

// State binds component credentials/cursors to an explicit production namespace.
func (s *Store) State(namespace model.StateNamespace) model.StateStore {
	return &namespaceState{store: s, namespace: namespace}
}

func (s *namespaceState) Get(ctx context.Context, key string) (*model.StateEntry, error) {
	return s.store.GetState(ctx, s.namespace, key)
}

func (s *namespaceState) List(ctx context.Context, input model.ListStateInput) ([]model.StateEntry, error) {
	return s.store.ListState(ctx, s.namespace, input)
}

func (s *namespaceState) CompareAndSet(ctx context.Context, input model.CompareAndSetStateInput) (model.MutationResult, error) {
	return s.store.CompareAndSetState(ctx, s.namespace, input)
}

func (s *namespaceState) Delete(ctx context.Context, key string, version int64) (model.MutationResult, error) {
	return s.store.DeleteState(ctx, s.namespace, key, version)
}
