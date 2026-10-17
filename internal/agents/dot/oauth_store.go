package dot

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/model"
)

const pendingLifetime = 5 * time.Minute
const codeLifetime = 5 * time.Minute
const accessLifetime = time.Hour
const refreshLifetime = 30 * 24 * time.Hour
const clientLifetime = 365 * 24 * time.Hour

type oauthError struct {
	code   string
	status int
}

func (e oauthError) Error() string { return e.code }

func oauthFailure(code string) error { return oauthError{code, 400} }

type oauthStore struct {
	state          model.StateStore
	prefix, secret string
}

func (s oauthStore) key(kind, value string) string {
	h := hmac.New(sha256.New, []byte(s.secret))
	_, _ = h.Write([]byte(value))
	return s.prefix + kind + "/" + hex.EncodeToString(h.Sum(nil))
}

func (s oauthStore) read(ctx context.Context, kind, value string) (*model.StateEntry, error) {
	entry, err := s.state.Get(ctx, s.key(kind, value))
	if err != nil {
		return nil, err
	}
	if entry == nil || entry.ExpiresAt == nil || !entry.ExpiresAt.After(time.Now()) {
		return nil, nil
	}
	return entry, nil
}

func (s oauthStore) load(ctx context.Context, kind, value string, out any) (*model.StateEntry, error) {
	entry, err := s.read(ctx, kind, value)
	if err != nil {
		return nil, err
	}
	if entry == nil || json.Unmarshal(entry.Value, out) != nil {
		return nil, oauthFailure("invalid_grant")
	}
	return entry, nil
}

func (s oauthStore) save(ctx context.Context, kind, value string, data any, lifetime time.Duration) error {
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}
	expires := time.Now().Add(lifetime)
	result, err := s.state.CompareAndSet(ctx, model.CompareAndSetStateInput{Key: s.key(kind, value), Value: encoded, ExpiresAt: &expires})
	if err != nil {
		return err
	}
	if result.Status != model.Updated {
		return oauthError{"temporarily_unavailable", 503}
	}
	return nil
}

func (s oauthStore) issue(ctx context.Context, kind string, data any, lifetime time.Duration) (string, error) {
	value := agentmcp.Opaque()
	return value, s.save(ctx, kind, value, data, lifetime)
}

func (s oauthStore) consume(ctx context.Context, entry *model.StateEntry) error {
	result, err := s.state.Delete(ctx, entry.Key, entry.Version)
	if err != nil {
		return err
	}
	if result.Status != model.Updated {
		return oauthFailure("invalid_grant")
	}
	return nil
}

func (s oauthStore) update(ctx context.Context, entry *model.StateEntry, data any) error {
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}
	result, err := s.state.CompareAndSet(ctx, model.CompareAndSetStateInput{Key: entry.Key, ExpectedVersion: &entry.Version, Value: encoded, ExpiresAt: entry.ExpiresAt})
	if err != nil {
		return err
	}
	if result.Status != model.Updated {
		return oauthFailure("invalid_grant")
	}
	return nil
}

func (s oauthStore) capacity(ctx context.Context, kind string) error {
	entries, err := s.state.List(ctx, model.ListStateInput{Prefix: s.prefix + kind + "/", Limit: 1000})
	if err != nil {
		return err
	}
	active := 0
	for i := range entries {
		entry := &entries[i]
		if entry.ExpiresAt != nil && !entry.ExpiresAt.After(time.Now()) {
			_, err = s.state.Delete(ctx, entry.Key, entry.Version)
			if err != nil {
				return err
			}
		} else {
			active++
		}
	}
	if active >= 1000 {
		return oauthError{"temporarily_unavailable", 503}
	}
	return nil
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func errorDetails(err error) (string, int) {
	var failure oauthError
	if errors.As(err, &failure) {
		return failure.code, failure.status
	}
	return "invalid_request", 400
}
