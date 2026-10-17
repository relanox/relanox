package common

import (
	"context"
	"sync"
	"time"
)

// TokenCache coalesces credential exchange while allowing waiting callers to
// cancel. Identity includes the current credential value, so rotation never
// reuses a token issued under the previous secret. Resolved values stay in memory.
type TokenCache struct {
	mu              sync.Mutex
	identity, token string
	expires         time.Time
	loading         chan struct{}
	generation      uint64
}

func (c *TokenCache) Invalidate() { c.mu.Lock(); c.token = ""; c.generation++; c.mu.Unlock() }

func (c *TokenCache) Get(ctx context.Context, identity string, fetch func(context.Context) (string, time.Time, error)) (string, error) {
	for {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		c.mu.Lock()
		if c.identity == identity && c.token != "" && time.Now().Before(c.expires) {
			token := c.token
			c.mu.Unlock()
			return token, nil
		}
		if pending := c.loading; pending != nil {
			c.mu.Unlock()
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-pending:
				continue
			}
		}
		c.loading = make(chan struct{})
		generation := c.generation
		c.mu.Unlock()
		token, expires, err := fetch(ctx)
		c.mu.Lock()
		if err == nil && generation == c.generation {
			c.identity = identity
			c.token = token
			c.expires = expires
		}
		close(c.loading)
		c.loading = nil
		c.mu.Unlock()
		return token, err
	}
}
