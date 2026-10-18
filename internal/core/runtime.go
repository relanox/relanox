// Package core owns authorization, immutable message plans and durable workers.
// Concrete native components are attached explicitly before Start.
package core

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

type Options struct {
	Observer  model.Observer
	PublicMux *http.ServeMux
	Preparers []model.Preparer
}

type Runtime struct {
	cfg           config.Config
	store         model.Storage
	observe       model.Observer
	mux           *http.ServeMux
	accounts      map[string]model.AccountConfig
	endpoints     map[string]model.EndpointConfig
	bindings      map[[3]string]model.Binding
	configured    map[string]model.ConversationRecord
	preparers     map[string]model.Preparer
	preparerOrder []model.Preparer
	channels      map[string]model.Channel
	agents        map[string]model.Agent
	connections   map[string]model.ConnectionStatus
	routes        map[string]bool
	mu            sync.RWMutex
	started       bool
	startDone     chan struct{}
	closed        bool
	cancel        context.CancelFunc
	workers       sync.WaitGroup
	accepting     atomic.Bool
	workerFailed  atomic.Bool
	owner         string
}

type Error struct{ code string }

func (e *Error) Error() string { return e.code }

func (e *Error) Code() string { return e.code }

func failure(code string) error { return &Error{code: code} }

func New(cfg config.Config, store model.Storage, options Options) (*Runtime, error) {
	if store == nil {
		return nil, failure("storage_required")
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return nil, failure("invalid_config")
	}
	validated, err := config.Decode(data)
	if err != nil {
		return nil, err
	}
	validated.Path = cfg.Path
	if options.PublicMux == nil {
		options.PublicMux = http.NewServeMux()
	}
	if options.Observer == nil {
		options.Observer = noopObserver{}
	}
	r := &Runtime{cfg: validated, store: store, observe: options.Observer, mux: options.PublicMux, accounts: map[string]model.AccountConfig{}, endpoints: map[string]model.EndpointConfig{}, bindings: map[[3]string]model.Binding{}, configured: map[string]model.ConversationRecord{}, preparers: map[string]model.Preparer{}, channels: map[string]model.Channel{}, agents: map[string]model.Agent{}, connections: map[string]model.ConnectionStatus{}, routes: map[string]bool{}, owner: uuid.NewString()}
	for _, account := range validated.Accounts {
		r.accounts[account.ID] = account
	}
	for _, endpoint := range validated.Endpoints {
		r.endpoints[endpoint.ID] = endpoint
	}
	for _, binding := range validated.Bindings {
		r.bindings[bindingKey(binding.AccountID, binding.ChatID, binding.ThreadID)] = binding
		conv := model.ConversationRecord{Address: conversationAddress(binding, r.endpoints[binding.EndpointID], r.accounts[binding.AccountID].Channel), Endpoint: r.endpoints[binding.EndpointID]}
		r.configured[conv.Address.ID] = conv
	}
	for _, preparer := range options.Preparers {
		if preparer == nil || !validID(preparer.ID(), 128) || r.preparers[preparer.ID()] != nil {
			return nil, failure("invalid_preparer_identity")
		}
		r.preparers[preparer.ID()] = preparer
		r.preparerOrder = append(r.preparerOrder, preparer)
	}
	if err := r.mountMedia(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Runtime) Handler() http.Handler { return r.mux }

func (r *Runtime) ChannelHost(accountID string) (model.ChannelHost, error) {
	account, ok := r.accounts[accountID]
	if !ok {
		return nil, failure("unknown_account")
	}
	return &channelHost{commonHost: commonHost{runtime: r, namespace: model.StateNamespace{Component: "channel:" + string(account.Channel), OwnerID: accountID}, prefix: "/channels/" + string(account.Channel) + "/" + accountID}, account: account}, nil
}

func (r *Runtime) AgentHost(kind model.AgentKind) (model.AgentHost, error) {
	if !kind.Valid() {
		return nil, failure("unknown_agent")
	}
	return &agentHost{commonHost: commonHost{runtime: r, namespace: model.StateNamespace{Component: "agent:" + string(kind), OwnerID: string(kind)}, prefix: "/agents/" + string(kind)}, kind: kind}, nil
}

func (r *Runtime) AttachChannel(accountID string, channel model.Channel) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	account, ok := r.accounts[accountID]
	if r.started || r.closed {
		return failure("runtime_already_started")
	}
	if !ok || channel == nil || channel.Kind() != account.Channel || r.channels[accountID] != nil {
		return failure("invalid_channel_attachment")
	}
	if err := validateCapabilities(channel.Capabilities()); err != nil {
		return err
	}
	r.channels[accountID] = channel
	return nil
}

func (r *Runtime) AttachAgent(endpointID string, agent model.Agent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	endpoint, ok := r.endpoints[endpointID]
	if r.started || r.closed {
		return failure("runtime_already_started")
	}
	if !ok || agent == nil || agent.Kind() != endpoint.Agent || r.agents[endpointID] != nil {
		return failure("invalid_agent_attachment")
	}
	r.agents[endpointID] = agent
	return nil
}

func (r *Runtime) Start(ctx context.Context) error {
	r.mu.Lock()
	if r.started || r.closed {
		r.mu.Unlock()
		return failure("runtime_already_started")
	}
	if len(r.channels) != len(r.accounts) || len(r.agents) != len(r.endpoints) {
		r.mu.Unlock()
		return failure("component_missing")
	}
	r.started = true
	r.startDone = make(chan struct{})
	defer close(r.startDone)
	lifetime, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	r.mu.Unlock()
	if err := r.store.Initialize(lifetime); err != nil {
		cancel()
		return err
	}
	conversations := make([]model.ConversationRecord, 0, len(r.configured))
	for _, conv := range r.configured {
		conversations = append(conversations, conv)
	}
	if err := r.store.RegisterConversations(lifetime, conversations); err != nil {
		cancel()
		return err
	}
	r.mu.Lock()
	if r.closed || lifetime.Err() != nil {
		r.mu.Unlock()
		cancel()
		return failure("startup_cancelled")
	}
	r.accepting.Store(true)
	r.mu.Unlock()
	if err := r.startComponents(lifetime); err != nil {
		r.accepting.Store(false)
		cancel()
		shutdown, stop := context.WithTimeout(context.WithoutCancel(ctx), r.shutdownTimeout())
		defer stop()
		r.mu.Lock()
		r.closed = true
		r.mu.Unlock()
		_ = r.closeComponents(shutdown)
		return err
	}
	for range r.cfg.Queue.Concurrency {
		r.workers.Go(func() { r.workLoop(lifetime) })
	}
	r.workers.Go(func() { r.maintenanceLoop(lifetime) })
	return nil
}

func (r *Runtime) startComponents(ctx context.Context) error {
	for _, endpoint := range r.cfg.Endpoints {
		if err := r.agents[endpoint.ID].Start(ctx); err != nil {
			return err
		}
	}
	for _, account := range r.cfg.Accounts {
		if err := r.channels[account.ID].Start(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) Close(ctx context.Context) error {
	r.mu.Lock()
	r.closed = true
	cancel := r.cancel
	startDone := r.startDone
	r.mu.Unlock()
	r.accepting.Store(false)
	if cancel != nil {
		cancel()
	}
	if startDone != nil {
		select {
		case <-startDone:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	componentCtx, stop := context.WithTimeout(ctx, r.shutdownTimeout())
	result := r.closeComponents(componentCtx)
	budgetExpired := componentCtx.Err() != nil
	stop()
	if budgetExpired && ctx.Err() == nil {
		// Native Lifecycle.Close remains joinable after its first deadline.
		// Preserve the timeout result while the owner's context waits for the
		// actual component shutdown before storage can be released.
		result = errors.Join(result, r.closeComponents(ctx))
	}
	done := make(chan struct{})
	go func() { r.workers.Wait(); close(done) }()
	select {
	case <-done:
		return result
	case <-ctx.Done():
		return errors.Join(result, ctx.Err())
	}
}

func (r *Runtime) shutdownTimeout() time.Duration {
	seconds := r.cfg.HTTP.ShutdownTimeoutSeconds
	if seconds <= 0 {
		seconds = 15
	}
	return time.Duration(seconds) * time.Second
}

func (r *Runtime) closeComponents(ctx context.Context) error {
	var result error
	for _, account := range r.cfg.Accounts {
		if channel := r.channels[account.ID]; channel != nil {
			result = errors.Join(result, channel.Close(ctx))
		}
	}
	for _, endpoint := range r.cfg.Endpoints {
		if agent := r.agents[endpoint.ID]; agent != nil {
			result = errors.Join(result, agent.Close(ctx))
		}
	}
	return result
}

func (r *Runtime) Readiness(ctx context.Context) (model.Health, error) {
	if !r.accepting.Load() {
		return model.Health{ErrorCode: "not_accepting"}, nil
	}
	if r.workerFailed.Load() {
		return model.Health{ErrorCode: "worker_failed"}, nil
	}
	return r.store.Health(ctx)
}

func (r *Runtime) SetAccepting(accepting bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	r.accepting.Store(accepting && r.started && !r.closed)
}

func (r *Runtime) Config() config.Config {
	var cfg config.Config
	_ = json.Unmarshal(canonical(r.cfg), &cfg)
	cfg.Path = r.cfg.Path
	return cfg
}

func (r *Runtime) channel(accountID string) model.Channel {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.channels[accountID]
}

func (r *Runtime) safeRetryAccounts() []string {
	var ids []string
	for id, channel := range r.channels {
		if channel.Capabilities().IdempotentSend {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	return ids
}

func validateCapabilities(c model.ChannelCapabilities) error {
	if c.MaxTextLength < 1 || !slices.Contains([]model.LengthUnit{model.UTF8, model.UTF16, model.Codepoint}, c.LengthUnit) || c.MaxChunksPerMessage < 0 || c.MaxAttachments < 0 {
		return failure("invalid_channel_capabilities")
	}
	if c.RichText != nil && (c.RichText.MaxParts < 1 || c.RichText.MaxTextLength < 1) {
		return failure("invalid_channel_capabilities")
	}
	return nil
}
