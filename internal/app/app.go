package app

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/observability"
	"github.com/relanox/relanox/internal/speech"
	"github.com/relanox/relanox/internal/storage"
)

type Options struct {
	LogWriter  io.Writer
	HTTPClient *http.Client
}

type Application struct {
	cfg               config.Config
	runtime           *core.Runtime
	store             *storage.Store
	observer          *observability.Observer
	public            *http.Server
	management        *http.Server
	mu                sync.Mutex
	started           bool
	closed            bool
	publicAddress     string
	managementAddress string
	errors            chan error
	servers           sync.WaitGroup
	closeOnce         sync.Once
	closeDone         chan struct{}
	closeErr          error
	stop              context.CancelFunc
}

func New(ctx context.Context, cfg config.Config, options Options) (*Application, error) {
	if err := Validate(cfg); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(cfg.HTTP.StartupTimeoutSeconds)*time.Second)
	defer cancel()
	if cfg.Storage.Driver == "sqlite" {
		cfg.Storage.Path = cfg.ResolvePath(cfg.Storage.Path)
		if err := os.MkdirAll(filepath.Dir(cfg.Storage.Path), 0700); err != nil {
			return nil, invalid("storage", "directory_unwritable")
		}
	}
	observer, err := observability.New(cfg.Observability, observability.Options{Writer: options.LogWriter})
	if err != nil {
		return nil, err
	}
	store, err := storage.Open(ctx, cfg.Storage, cfg.ResolveSecret)
	if err != nil {
		_ = observer.Close(context.Background())
		if errors.Is(err, storage.ErrIncompatibleDatabase) {
			return nil, invalid("storage", "incompatible_database_requires_explicit_migration")
		}
		return nil, invalid("storage", "initialization_failed")
	}
	a := &Application{cfg: cfg, store: store, observer: observer, errors: make(chan error, 2), closeDone: make(chan struct{})}
	preparers, err := a.preparers(options.HTTPClient)
	if err == nil {
		a.runtime, err = core.New(cfg, store, core.Options{Observer: observer, Preparers: preparers})
	}
	if err == nil {
		err = attachComponents(a.runtime, cfg, options.HTTPClient)
	}
	if err != nil {
		_ = a.Close(context.Background())
		return nil, err
	}
	a.public = a.server(a.runtime.Handler())
	a.management = a.server(a.managementHandler())
	return a, nil
}

func (a *Application) preparers(client *http.Client) ([]model.Preparer, error) {
	if a.cfg.Speech == nil || !a.cfg.Speech.Enabled {
		return nil, nil
	}
	preparer, err := speech.New(*a.cfg.Speech, speech.Options{ResolveSecret: a.cfg.ResolveSecret, HTTPClient: client, Observer: a.observer})
	if err != nil {
		return nil, err
	}
	return []model.Preparer{preparer}, nil
}

func (a *Application) server(handler http.Handler) *http.Server {
	return &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: time.Duration(a.cfg.HTTP.ReadTimeoutSeconds) * time.Second, WriteTimeout: time.Duration(a.cfg.HTTP.WriteTimeoutSeconds) * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20, ErrorLog: log.New(io.Discard, "", 0)}
}

func (a *Application) managementHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		agentmcp.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		health, err := a.runtime.Readiness(r.Context())
		status := http.StatusOK
		if err != nil {
			health = model.Health{ErrorCode: "storage_unavailable"}
		}
		if !health.OK {
			status = http.StatusServiceUnavailable
		}
		agentmcp.JSON(w, status, health)
	})
	mux.Handle("/metrics", a.observer.Handler())
	return mux
}

// Start binds both listeners before starting native components. Constructor or
// listener failures roll back all resources acquired by this application.
func (a *Application) Start(ctx context.Context) error {
	a.mu.Lock()
	if a.started || a.closed {
		a.mu.Unlock()
		return invalid("runtime", "already_started_or_closed")
	}
	a.started = true
	lifetime, cancel := context.WithCancel(ctx)
	a.stop = cancel
	timer := time.AfterFunc(time.Duration(a.cfg.HTTP.StartupTimeoutSeconds)*time.Second, cancel)
	defer timer.Stop()
	listenerConfig := net.ListenConfig{}
	public, err := listenerConfig.Listen(lifetime, "tcp", a.cfg.HTTP.Listen)
	if err != nil {
		a.mu.Unlock()
		_ = a.Close(context.Background())
		return invalid("http.listen", "bind_failed")
	}
	management, err := listenerConfig.Listen(lifetime, "tcp", a.cfg.HTTP.ManagementListen)
	if err != nil {
		_ = public.Close()
		a.mu.Unlock()
		_ = a.Close(context.Background())
		return invalid("http.managementListen", "bind_failed")
	}
	a.publicAddress = public.Addr().String()
	a.managementAddress = management.Addr().String()
	a.serve(a.public, public)
	a.serve(a.management, management)
	a.mu.Unlock()
	err = a.runtime.Start(lifetime)
	if !timer.Stop() || lifetime.Err() != nil || err != nil {
		_ = a.Close(context.Background())
		return invalid("runtime", "component_start_failed")
	}
	return nil
}

func (a *Application) serve(server *http.Server, listener net.Listener) {
	a.servers.Go(func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			a.errors <- invalid("http", "listener_failed")
		}
	})
}

func (a *Application) Addresses() (string, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.publicAddress, a.managementAddress
}

func (a *Application) Run(ctx context.Context) error {
	if err := a.Start(ctx); err != nil {
		return err
	}
	var result error
	select {
	case <-ctx.Done():
	case result = <-a.errors:
	}
	shutdown, cancel := a.shutdownContext()
	defer cancel()
	return errors.Join(result, a.Close(shutdown))
}

func (a *Application) Close(ctx context.Context) error {
	a.closeOnce.Do(func() { go a.closeResources() })
	select {
	case <-a.closeDone:
		return a.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *Application) closeResources() {
	defer close(a.closeDone)
	a.mu.Lock()
	a.closed = true
	if a.stop != nil {
		a.stop()
	}
	a.mu.Unlock()
	shutdown, cancel := a.shutdownContext()
	defer cancel()
	if a.runtime != nil {
		a.runtime.SetAccepting(false)
	}
	// Cancellation reaches native connections and durable workers while HTTP
	// drains. Storage remains open until both have actually finished, even if a
	// caller's shutdown deadline expires while waiting for this background join.
	runtimeDone := make(chan error, 1)
	go func() {
		if a.runtime == nil {
			runtimeDone <- nil
			return
		}
		runtimeDone <- a.runtime.Close(context.Background())
	}()
	for _, server := range []*http.Server{a.public, a.management} {
		if server == nil {
			continue
		}
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			a.closeErr = errors.Join(a.closeErr, invalid("http", "shutdown_timeout"))
		}
	}
	a.servers.Wait()
	a.closeErr = errors.Join(a.closeErr, <-runtimeDone)
	a.closeErr = errors.Join(a.closeErr, a.store.Close(), a.observer.Close(shutdown))
}

func (a *Application) shutdownContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), time.Duration(a.cfg.HTTP.ShutdownTimeoutSeconds)*time.Second)
}
