package app_test

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/app"
	"github.com/relanox/relanox/internal/config"
)

// Configurable startup must cancel actual storage I/O. The existing application
// test uses responsive SQLite, so it cannot detect an ignored startup budget.
// This TCP peer withholds the PostgreSQL startup response, per the wire protocol:
// https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-START-UP
func TestStartupBudgetCancelsPostgresHandshake(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	received := make(chan struct{}, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer func() { _ = connection.Close() }()
		var header [8]byte
		if _, readErr := io.ReadFull(connection, header[:]); readErr == nil {
			received <- struct{}{}
			_, _ = io.Copy(io.Discard, connection)
		}
	}()
	t.Setenv("APP_STARTUP_POSTGRES", "postgres://startup@"+listener.Addr().String()+"/startup?sslmode=disable")
	cfg, err := config.Decode([]byte(`{"storage":{"driver":"postgres","url":{"env":"APP_STARTUP_POSTGRES"}},"http":{"startupTimeoutSeconds":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	start := time.Now()
	application, err := app.New(ctx, cfg, app.Options{LogWriter: io.Discard})
	if application != nil {
		_ = application.Close(context.Background())
	}
	if err == nil || time.Since(start) > 2500*time.Millisecond {
		t.Fatalf("startup budget ignored: elapsed=%s error=%v", time.Since(start), err)
	}
	select {
	case <-received:
	default:
		t.Fatal("startup failed before native PostgreSQL I/O")
	}
}

func lifecycleApplication(t *testing.T) *app.Application {
	t.Helper()
	t.Setenv("APP_LIFECYCLE_BOT", "123:bot-secret")
	t.Setenv("APP_LIFECYCLE_WEBHOOK", "webhook-secret")
	cfg, err := config.Decode([]byte(`{"storage":{"driver":"sqlite","path":"relay.db"},"http":{"listen":"127.0.0.1:0","managementListen":"127.0.0.1:0","startupTimeoutSeconds":1,"shutdownTimeoutSeconds":1},"accounts":[{"id":"telegram","channel":"telegram","allowedSenders":["22"],"config":{"botToken":{"env":"APP_LIFECYCLE_BOT"},"webhookSecret":{"env":"APP_LIFECYCLE_WEBHOOK"}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Path = filepath.Join(t.TempDir(), "relay.json")
	application, err := app.New(context.Background(), cfg, app.Options{LogWriter: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = application.Close(context.Background()) })
	if err = application.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	return application
}

// A startup deadline must end when startup succeeds, while the production
// lifetime stays active. Readiness after that budget catches accidental use of
// a short-lived context for native connections and workers.
func TestSuccessfulStartupKeepsLifetimeAfterBudget(t *testing.T) {
	application := lifecycleApplication(t)
	<-time.After(1200 * time.Millisecond)
	_, management := application.Addresses()
	assertStatus(t, "http://"+management+"/health/ready", http.StatusOK)
}

// A real incomplete webhook body keeps an HTTP handler active. Expect/Continue
// confirms the handler started reading before Close, without an application-only
// seam. A healthy round trip never exercises the configured drain timeout.
func TestShutdownBudgetClosesIncompleteWebhook(t *testing.T) {
	application := lifecycleApplication(t)
	public, _ := application.Addresses()
	connection, err := net.DialTimeout("tcp", public, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = connection.Close() }()
	if err = connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err = fmt.Fprintf(connection, "POST /channels/telegram/telegram/webhook HTTP/1.1\r\nHost: %s\r\nX-Telegram-Bot-Api-Secret-Token: webhook-secret\r\nContent-Length: 1024\r\nExpect: 100-continue\r\n\r\n", public); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil || !strings.Contains(line, "100 Continue") {
		t.Fatalf("webhook not reading its body: %q %v", line, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	start := time.Now()
	err = application.Close(ctx)
	if err == nil || time.Since(start) > 2500*time.Millisecond || !strings.Contains(err.Error(), "shutdown_timeout") {
		t.Fatalf("shutdown budget ignored: elapsed=%s error=%v", time.Since(start), err)
	}
}
