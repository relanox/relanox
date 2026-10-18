package agentmcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// Signed uploads must retain controlled failure codes so clients can distinguish
// a changed retry from invalid media metadata. Capability-only tests never call
// the real core/SQLite upload path and missed generic upload_failed responses.
// These requests use the production ticket, HTTP handler, scoped media and store.
func TestUploadFailuresExposeControlledCodesFromRealStorage(t *testing.T) {
	server, handler, channelID := uploadServer(t)
	input := uploadInput{Channel: channelID, Kind: model.File, MIMEType: "text/plain", FileName: "answer.txt", Size: 3}
	uri := uploadCapability(t, server, input)
	first := putUpload(handler, uri, "abc")
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), `"fileId"`) {
		t.Fatalf("initial upload: %d %s", first.Code, first.Body.String())
	}
	assertUploadFailure(t, putUpload(handler, uri, "xyz"), http.StatusConflict, "media_conflict")
	input.PreviewMediaID = "00112233-4455-6677-8899-aabbccddeeff"
	uri = uploadCapability(t, server, input)
	assertUploadFailure(t, putUpload(handler, uri, "abc"), http.StatusBadRequest, "invalid_media_preview")
}

func uploadServer(t *testing.T) (*Server, http.Handler, string) {
	t.Helper()
	t.Setenv("MCP_UPLOAD_TOKEN", "upload-secret")
	endpoint := model.EndpointConfig{ID: "muse", Agent: model.Muse, Config: json.RawMessage(`{}`)}
	cfg := config.Config{
		Accounts:  []model.AccountConfig{{ID: "telegram", Channel: model.Telegram, AllowedSenders: []string{"alice"}, Config: json.RawMessage(`{}`)}},
		Endpoints: []model.EndpointConfig{endpoint},
		Bindings:  []model.Binding{{AccountID: "telegram", ChatID: "chat", EndpointID: "muse"}},
		Storage:   config.Storage{Driver: "sqlite", Path: filepath.Join(t.TempDir(), "media.sqlite")},
		HTTP:      config.HTTP{PublicURL: "https://relay.example"},
	}
	store, err := storage.Open(context.Background(), cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	runtime, err := core.New(cfg, store, core.Options{})
	if err != nil {
		t.Fatal(err)
	}
	channel, err := runtime.ChannelHost("telegram")
	if err != nil {
		t.Fatal(err)
	}
	address := channel.BoundAddresses()[0]
	if err := store.RegisterConversations(context.Background(), []model.ConversationRecord{{Address: address, Endpoint: endpoint}}); err != nil {
		t.Fatal(err)
	}
	host, err := runtime.AgentHost(model.Muse)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Options{Endpoint: endpoint, Config: Config{Token: model.SecretRef{Env: "MCP_UPLOAD_TOKEN"}}, Dependencies: Dependencies{Host: host}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := server.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return server, http.HandlerFunc(server.serveMedia), address.ID
}

func uploadCapability(t *testing.T, server *Server, input uploadInput) string {
	t.Helper()
	result, err := server.createUpload(context.Background(), input)
	if err != nil || result.IsError {
		t.Fatalf("create upload: %+v %v", result, err)
	}
	return result.StructuredContent.(map[string]any)["uploadUrl"].(string)
}

func putUpload(handler http.Handler, uri, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPut, uri, strings.NewReader(body))
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertUploadFailure(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != status || body.Error != code {
		t.Fatalf("upload failure = %d %s, want %d %s", response.Code, response.Body.String(), status, code)
	}
}

// Only exact internal operational codes may cross the upload HTTP boundary.
// A remote/storage diagnostic resembling a code must remain generic; the real
// storage test above protects classification at the actual response call site.
func TestUploadFailureMappingRejectsUntrustedDiagnostics(t *testing.T) {
	for _, row := range []struct {
		err    string
		status int
		code   string
	}{
		{"media_conflict", 409, "media_conflict"},
		{"media_too_large", 413, "media_too_large"},
		{"media_total_too_large", 413, "media_total_too_large"},
		{"too_many_attachments", 413, "too_many_attachments"},
		{"invalid_media_preview", 400, "invalid_media_preview"},
		{"media_storage_missing", 503, "media_storage_missing"},
		{"media_conflict credential=private-token", 500, "upload_failed"},
		{"private-storage-diagnostic", 500, "upload_failed"},
	} {
		status, code := uploadFailure(errors.New(row.err))
		if status != row.status || code != row.code {
			t.Fatalf("uncontrolled upload response: status=%d code=%q", status, code)
		}
	}
}
