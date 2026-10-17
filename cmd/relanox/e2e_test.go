package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/relanox/relanox/internal/model"
)

// The actual executable must load relative configuration paths, mount native
// authenticated ingress/MCP and preserve final delivery across a process crash.
// In-process app tests cannot catch CLI wiring or reopening a process-owned WAL.
// Keep this test in the command package so changes to the executable and its
// transitive imports invalidate Go's test cache; subprocess build inputs alone
// are not dependencies of an unrelated end-to-end test package.
// The native peer implements only Telegram HTTP, never relay state or retries.
// Fixtures: https://core.telegram.org/bots/api#update and #sendmessage.
func TestCLIReplySurvivesCrashAndDeduplicatesReplay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	directory := t.TempDir()
	binary := buildCLI(t, ctx, directory)
	var sends atomic.Int32
	wire := make(chan string, 8)
	peer := telegramPeer(t, &sends, wire)
	defer peer.Close()
	public, management := unusedAddresses(t)
	configPath := writeConfig(t, directory, public, management, peer.URL)
	process := startCLI(t, ctx, binary, configPath, directory)
	awaitReady(t, ctx, process, management)
	postInput(t, ctx, public, "wrong-secret", http.StatusUnauthorized)
	postInput(t, ctx, public, "webhook-secret", http.StatusOK)
	assertMCPAuthentication(t, ctx, public)
	session := connectMCP(t, ctx, public)
	message := readMessage(t, ctx, session)
	arguments := map[string]any{"channel": message.Source.Channel.ID, "text": "- [x] done", "idempotencyKey": "durable-final", "reply": map[string]any{"requestId": message.RequestID, "kind": "final"}}
	first := sendFinal(t, ctx, session, arguments)
	select {
	case text := <-wire:
		if text != "• [x] done" {
			t.Errorf("native checklist text = %q; want checked state preserved", text)
		}
	case <-ctx.Done():
		t.Fatal("native final send missing")
	}
	awaitFinal(t, ctx, session, message.RequestID)
	closeSession(t, session)
	process.crash(t)
	if _, err := os.Stat(filepath.Join(directory, "state", "relay.db")); err != nil {
		t.Fatalf("database was not resolved beside selected configuration: %v", err)
	}
	process = startCLI(t, ctx, binary, configPath, directory)
	awaitReady(t, ctx, process, management)
	postInput(t, ctx, public, "webhook-secret", http.StatusOK)
	session = connectMCP(t, ctx, public)
	retained := readMessage(t, ctx, session)
	if retained.RequestID != message.RequestID || retained.Text != "operator input" {
		t.Fatalf("duplicate ingress or crash changed retained request: %+v", retained)
	}
	replay := sendFinal(t, ctx, session, arguments)
	if replay.DeliveryID != first.DeliveryID || !replay.Replay {
		t.Fatalf("final replay did not reuse durable delivery: first=%+v replay=%+v", first, replay)
	}
	awaitFinal(t, ctx, session, message.RequestID)
	closeSession(t, session)
	process.crash(t)
	if sends.Load() != 1 {
		t.Fatalf("duplicate ingress/final replay produced %d native sends", sends.Load())
	}
}

func buildCLI(t *testing.T, ctx context.Context, directory string) string {
	t.Helper()
	name := "relanox"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(directory, name)
	command := exec.CommandContext(ctx, "go", "build", "-o", binary, "./cmd/relanox")
	command.Dir = filepath.Join("..", "..")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	return binary
}

func unusedAddresses(t *testing.T) (string, string) {
	t.Helper()
	public, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := public.Close(); err != nil {
			t.Error(err)
		}
	}()
	management, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := management.Close(); err != nil {
			t.Error(err)
		}
	}()
	return public.Addr().String(), management.Addr().String()
}

func writeConfig(t *testing.T, directory, public, management, api string) string {
	t.Helper()
	t.Setenv("E2E_BOT", "123:bot-secret")
	t.Setenv("E2E_WEBHOOK", "webhook-secret")
	t.Setenv("E2E_MCP", "mcp-secret")
	t.Setenv("E2E_ROUTINE", "")
	t.Setenv("E2E_ROUTINE_AUTH", "")
	data, err := json.Marshal(map[string]any{
		"storage":   map[string]any{"driver": "sqlite", "path": "state/relay.db"},
		"http":      map[string]any{"listen": public, "managementListen": management, "publicUrl": "http://" + public},
		"queue":     map[string]any{"pollIntervalMs": 5},
		"accounts":  []any{map[string]any{"id": "telegram", "channel": "telegram", "allowedSenders": []string{"22"}, "config": map[string]any{"botToken": model.SecretRef{Env: "E2E_BOT"}, "webhookSecret": model.SecretRef{Env: "E2E_WEBHOOK"}, "apiBaseUrl": api, "allowInsecureLoopback": true}}},
		"endpoints": []any{map[string]any{"id": "grok", "agent": "grok", "config": map[string]any{"mcp": map[string]any{"token": model.SecretRef{Env: "E2E_MCP"}}, "routineUrl": model.SecretRef{Env: "E2E_ROUTINE"}, "routineAuthorization": model.SecretRef{Env: "E2E_ROUTINE_AUTH"}}}},
		"bindings":  []model.Binding{{AccountID: "telegram", ChatID: "-1001", EndpointID: "grok"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "relay.json")
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

type cliProcess struct {
	command *exec.Cmd
	done    chan error
	log     *os.File
	stopped bool
}

func startCLI(t *testing.T, ctx context.Context, binary, configuration, directory string) *cliProcess {
	t.Helper()
	log, err := os.CreateTemp(directory, "process-*.log")
	if err != nil {
		t.Fatal(err)
	}
	p := &cliProcess{command: exec.CommandContext(ctx, binary, "run", "--config", configuration), done: make(chan error, 1), log: log}
	// Run from a different directory to exercise configuration-relative storage.
	p.command.Dir = filepath.Dir(directory)
	p.command.Stdout, p.command.Stderr = log, log
	t.Cleanup(func() { p.crash(t) })
	if err = p.command.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { p.done <- p.command.Wait() }()
	return p
}

func (p *cliProcess) crash(t *testing.T) {
	t.Helper()
	if p.stopped {
		return
	}
	p.stopped = true
	if p.command.Process != nil {
		if err := p.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Error(err)
		}
		select {
		case err := <-p.done:
			var exit *exec.ExitError
			if err != nil && !errors.As(err, &exit) {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("CLI did not exit after Kill")
		}
	}
	if err := p.log.Close(); err != nil {
		t.Error(err)
	}
}

func awaitReady(t *testing.T, ctx context.Context, process *cliProcess, address string) {
	t.Helper()
	client := &http.Client{Timeout: time.Second}
	for {
		response, err := client.Get("http://" + address + "/health/ready")
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		select {
		case err = <-process.done:
			process.done <- err
			data, readErr := os.ReadFile(process.log.Name())
			t.Fatalf("CLI exited during startup: %v; log=%s; read=%v", err, data, readErr)
		case <-ctx.Done():
			t.Fatal("CLI listener did not start")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func telegramPeer(t *testing.T, sends *atomic.Int32, wire chan<- string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bot123:bot-secret/sendMessage" {
			t.Errorf("unexpected Telegram request %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		defer func() {
			if err := r.MultipartForm.RemoveAll(); err != nil {
				t.Error(err)
			}
		}()
		if r.FormValue("chat_id") != "-1001" {
			t.Errorf("wrong native destination %q", r.FormValue("chat_id"))
		}
		var reply struct {
			MessageID int `json:"message_id"`
		}
		if err := json.Unmarshal([]byte(r.FormValue("reply_parameters")), &reply); err != nil || reply.MessageID != 8 {
			t.Errorf("native final lost incoming message reference: %+v, %v", reply, err)
		}
		sends.Add(1)
		wire <- r.FormValue("text")
		if _, err := io.WriteString(w, `{"ok":true,"result":{"message_id":102}}`); err != nil {
			t.Error(err)
		}
	}))
}

func postInput(t *testing.T, ctx context.Context, public, secret string, want int) {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, "POST", "http://"+public+"/channels/telegram/telegram/webhook", strings.NewReader(`{"update_id":7,"message":{"message_id":8,"from":{"id":22,"is_bot":false},"chat":{"id":-1001,"type":"supergroup"},"text":"operator input"}}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Telegram-Bot-Api-Secret-Token", secret)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != want {
		t.Fatalf("native ingress status=%d want=%d", response.StatusCode, want)
	}
}

type bearerTransport struct{}

func (bearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.Header.Set("Authorization", "Bearer mcp-secret")
	return http.DefaultTransport.RoundTrip(request)
}

func connectMCP(t *testing.T, ctx context.Context, public string) *mcp.ClientSession {
	t.Helper()
	session, err := mcp.NewClient(&mcp.Implementation{Name: "cli-e2e", Version: "1"}, nil).Connect(ctx, &mcp.StreamableClientTransport{Endpoint: "http://" + public + "/agents/grok/mcp/grok", HTTPClient: &http.Client{Transport: bearerTransport{}}, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func assertMCPAuthentication(t *testing.T, ctx context.Context, public string) {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, "POST", "http://"+public+"/agents/grok/mcp/grok", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated MCP status=%d", response.StatusCode)
	}
}

func closeSession(t *testing.T, session *mcp.ClientSession) {
	t.Helper()
	if err := session.Close(); err != nil {
		t.Error(err)
	}
}

func callTool(t *testing.T, ctx context.Context, session *mcp.ClientSession, name string, arguments any, out any) {
	t.Helper()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil || result.IsError {
		t.Fatalf("%s result=%+v err=%v", name, result, err)
	}
	data, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, out); err != nil {
		t.Fatal(err)
	}
}

type incomingMessage struct {
	RequestID string `json:"requestId"`
	Text      string `json:"text"`
	Source    struct {
		Channel model.ChannelAddress `json:"channel"`
	} `json:"source"`
}

func readMessage(t *testing.T, ctx context.Context, session *mcp.ClientSession) incomingMessage {
	t.Helper()
	var result struct {
		Messages []incomingMessage
	}
	callTool(t, ctx, session, "relanox_read_messages", map[string]any{}, &result)
	if len(result.Messages) != 1 {
		t.Fatalf("expected one retained incoming request, got %+v", result)
	}
	return result.Messages[0]
}

type sendReceipt struct {
	Status     string `json:"status"`
	DeliveryID string `json:"deliveryId"`
	Replay     bool   `json:"replay"`
}

func sendFinal(t *testing.T, ctx context.Context, session *mcp.ClientSession, arguments map[string]any) sendReceipt {
	t.Helper()
	var result sendReceipt
	callTool(t, ctx, session, "relanox_send_message", arguments, &result)
	if result.Status != "queued" || result.DeliveryID == "" {
		t.Fatalf("final not queued: %+v", result)
	}
	return result
}

func awaitFinal(t *testing.T, ctx context.Context, session *mcp.ClientSession, requestID string) {
	t.Helper()
	for {
		var status model.AgentStatus
		callTool(t, ctx, session, "relanox_status", map[string]any{"requestId": requestID}, &status)
		if status.Request != nil && status.Request.Reply.Status == model.Sent {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("final delivery did not complete: %+v", status)
		case <-time.After(20 * time.Millisecond):
		}
	}
}
