package storage

import (
	"context"
	"encoding/json"
	"time"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage/ent"
	"github.com/relanox/relanox/internal/storage/ent/predicate"
	"github.com/relanox/relanox/internal/storage/ent/state"
)

func stateScope(namespace model.StateNamespace, key string) []predicate.State {
	return []predicate.State{state.ComponentEQ(namespace.Component), state.OwnerIDEQ(namespace.OwnerID), state.KeyEQ(key)}
}

func publicState(row *ent.State) model.StateEntry {
	entry := model.StateEntry{Key: row.Key, Value: row.Value, Version: row.Version}
	if row.ExpiresAt != nil {
		expires := time.Unix(0, *row.ExpiresAt).UTC()
		entry.ExpiresAt = &expires
	}
	return entry
}

func (s *Store) GetState(ctx context.Context, namespace model.StateNamespace, key string) (*model.StateEntry, error) {
	row, err := s.client.State.Query().Where(stateScope(namespace, key)...).Where(state.Live(true)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entry := publicState(row)
	return &entry, nil
}

func (s *Store) ListState(ctx context.Context, namespace model.StateNamespace, input model.ListStateInput) ([]model.StateEntry, error) {
	q := s.client.State.Query().Where(state.ComponentEQ(namespace.Component), state.OwnerIDEQ(namespace.OwnerID), state.Live(true), state.KeyHasPrefix(input.Prefix))
	if input.ExpiresBefore != nil {
		q.Where(state.ExpiresAtLTE(input.ExpiresBefore.UnixNano()))
	}
	rows, err := q.Order(state.ByKey()).Limit(bounded(input.Limit, 100, 1000)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]model.StateEntry, 0, len(rows))
	for _, row := range rows {
		out = append(out, publicState(row))
	}
	return out, nil
}

func (s *Store) CompareAndSetState(ctx context.Context, namespace model.StateNamespace, input model.CompareAndSetStateInput) (model.MutationResult, error) {
	result := model.MutationResult{Status: model.Conflict}
	if namespace.Component == "" || namespace.OwnerID == "" || input.Key == "" || !json.Valid(input.Value) {
		return result, nil
	}
	err := s.write(ctx, func(tx *ent.Tx) error {
		result = model.MutationResult{Status: model.Conflict}
		row, err := tx.State.Query().Where(stateScope(namespace, input.Key)...).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return err
		}
		if !stateExpected(row, input.ExpectedVersion) {
			return nil
		}
		version := int64(1)
		if row != nil {
			version = row.Version + 1
		}
		if err := putState(ctx, tx, row, namespace, input, version); err != nil {
			return err
		}
		result = model.MutationResult{Status: model.Updated, Version: version}
		return nil
	})
	return result, err
}

func stateExpected(row *ent.State, expected *int64) bool {
	if expected == nil {
		return row == nil || !row.Live
	}
	return row != nil && row.Live && row.Version == *expected
}

func putState(ctx context.Context, tx *ent.Tx, row *ent.State, namespace model.StateNamespace, input model.CompareAndSetStateInput, version int64) error {
	if row == nil {
		create := tx.State.Create().SetID(digest([]string{namespace.Component, namespace.OwnerID, input.Key})).SetComponent(namespace.Component).SetOwnerID(namespace.OwnerID).SetKey(input.Key).SetLive(true).SetVersion(version).SetValue(input.Value)
		if input.ExpiresAt != nil {
			create.SetExpiresAt(input.ExpiresAt.UnixNano())
		}
		return create.Exec(ctx)
	}
	update := tx.State.UpdateOneID(row.ID).SetLive(true).SetVersion(version).SetValue(input.Value)
	if input.ExpiresAt != nil {
		update.SetExpiresAt(input.ExpiresAt.UnixNano())
	} else {
		update.ClearExpiresAt()
	}
	return update.Exec(ctx)
}

func (s *Store) DeleteState(ctx context.Context, namespace model.StateNamespace, key string, expected int64) (model.MutationResult, error) {
	result := model.MutationResult{Status: model.Conflict}
	err := s.write(ctx, func(tx *ent.Tx) error {
		result = model.MutationResult{Status: model.Conflict}
		row, err := tx.State.Query().Where(stateScope(namespace, key)...).Only(ctx)
		if ent.IsNotFound(err) {
			result.Status = model.NotFound
			return nil
		}
		if err != nil {
			return err
		}
		if !row.Live || row.Version != expected {
			return nil
		}
		if err := tx.State.UpdateOneID(row.ID).SetLive(false).SetVersion(row.Version + 1).ClearValue().ClearExpiresAt().Exec(ctx); err != nil {
			return err
		}
		result = model.MutationResult{Status: model.Updated, Version: row.Version + 1}
		return nil
	})
	return result, err
}
