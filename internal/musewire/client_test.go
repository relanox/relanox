package musewire

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
)

// Real TLS HTTP/WebSocket peers exercise production request generation, token
// persistence and ciphertext. A lost session_id, wrong refresh prefix, reused
// rotating token, or cancellation before send being marked uncertain fails
// these tests. Archived TS tests mock MuseClient, bypassing all these layers.
// HTTPClient is a deployment TLS/proxy/instrumentation option, not a test seam.
// The peer models only Muse's external protocols; no Relanox core behavior.
func TestSendMessageRotatesCredentialsAndPreservesSession(t *testing.T) {
	var refreshes atomic.Int32
	var sends atomic.Int32
	server := httptest.NewTLSServer(rotationHandler(t, &refreshes, &sends))
	defer server.Close()
	directory := pairedDirectory(t, server.URL)
	options := Options{CredentialsDirectory: directory, HTTPClient: server.Client(), SessionID: "session-native"}
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			ack, err := SendMessage(context.Background(), options, "payload")
			if err != nil || ack.MessageID != "native-message" {
				t.Errorf("ack %+v: %v", ack, err)
			}
		})
	}
	wg.Wait()
	if refreshes.Load() != 1 || sends.Load() != 2 {
		t.Fatalf("refreshes=%d sends=%d", refreshes.Load(), sends.Load())
	}
	data, err := os.ReadFile(filepath.Join(directory, "pairing.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if json.Unmarshal(data, &stored) != nil || stored["refresh_token"] != "hatch_refresh:new-refresh" || stored["untouched"] != "retained" {
		t.Fatalf("invalid persisted credentials: %s", data)
	}
	files, err := filepath.Glob(filepath.Join(directory, ".pairing-*.tmp"))
	if err != nil || len(files) != 0 {
		t.Fatal("leaked credential temporary files", err)
	}
}

func TestCancellationWhileDirectoryQueuedReturnsWithoutNetwork(t *testing.T) {
	directory := t.TempDir()
	release, err := lockDirectory(context.Background(), directory)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := SendMessage(ctx, Options{CredentialsDirectory: directory}, "payload"); done <- err }()
	cancel()
	select {
	case err = <-done:
		assertDispatchError(t, err, false, "queue")
	case <-time.After(time.Second):
		t.Fatal("cancelled waiter remained blocked")
	}
}

// Official muse_api.py appends paths to api_url_v2 and rotates refresh tokens.
// Cancelling a request after refresh has started must retain the directory lock
// until the successor reaches disk. The old TS client permitted cancellation to
// interrupt that response. This test uses real files and a real TLS exchange.
func TestRefreshSettlesBeforeCancellationReleasesDirectory(t *testing.T) {
	started := make(chan struct{})
	finish := make(chan struct{})
	var refreshCancelled atomic.Bool
	var fetches atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/tenant/v2/fetch_vms":
			fetches.Add(1)
			if r.Header.Get("Authorization") == "Bearer old-access" {
				w.WriteHeader(401)
				return
			}
			w.WriteHeader(503)
		case "/tenant/v2/device_token/refresh":
			close(started)
			select {
			case <-finish:
			case <-r.Context().Done():
				refreshCancelled.Store(true)
				return
			}
			_, _ = io.WriteString(w, `{"access_token":"new-access","refresh_token":"new-refresh"}`)
		default:
			t.Errorf("API prefix lost: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	directory := pairedDirectory(t, server.URL+"/tenant/v2/")
	options := Options{CredentialsDirectory: directory, HTTPClient: server.Client()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := SendMessage(ctx, options, "payload"); done <- err }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("refresh was not reached")
	}
	cancel()
	// A cancelled second dispatch must leave the leased directory immediately.
	waitCtx, waitCancel := context.WithCancel(context.Background())
	waitCancel()
	_, err := SendMessage(waitCtx, options, "other")
	assertDispatchError(t, err, false, "queue")
	select {
	case err = <-done:
		t.Fatalf("refresh returned before saving successor: %v", err)
	default:
	}
	close(finish)
	select {
	case err = <-done:
		assertDispatchError(t, err, false, "account")
	case <-time.After(3 * time.Second):
		t.Fatal("refresh did not settle")
	}
	if refreshCancelled.Load() {
		t.Fatal("caller cancelled rotating refresh exchange")
	}
	creds, err := loadCredentials(directory)
	if err != nil || creds.RefreshToken != "new-refresh" {
		t.Fatal("lost successor", err)
	}
	_, err = SendMessage(context.Background(), options, "later")
	assertDispatchError(t, err, false, "account")
	if fetches.Load() != 2 {
		t.Fatalf("unexpected fetch count: %d", fetches.Load())
	}
}

func TestCancellationBeforeAndAfterChatWrite(t *testing.T) {
	for _, stage := range []string{"account", "connect", "acknowledgement"} {
		t.Run(stage, func(t *testing.T) {
			started := make(chan struct{})
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/fetch_vms" {
					if stage == "account" {
						close(started)
						<-r.Context().Done()
						return
					}
					_, _ = io.WriteString(w, `{"vm_list":[{"vm_id":"vm-A","vm_url":"wss://unused.example","vm_auth_token":"vm-token"}]}`)
					return
				}
				if stage == "connect" {
					conn, err := websocket.Accept(w, r, nil)
					if err != nil {
						return
					}
					defer conn.CloseNow()
					if _, _, err = conn.Read(r.Context()); err != nil {
						return
					}
					close(started)
					_, _, _ = conn.Read(r.Context())
					return
				}
				peerChat(t, w, r, func([]byte) { close(started) }, true)
			}))
			defer server.Close()
			directory := pairedDirectory(t, server.URL)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := SendMessage(ctx, Options{CredentialsDirectory: directory, HTTPClient: server.Client()}, "payload")
				done <- err
			}()
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("peer was never reached")
			}
			cancel()
			select {
			case err := <-done:
				assertDispatchError(t, err, stage == "acknowledgement", stage)
			case <-time.After(time.Second):
				t.Fatal("cancelled operation remained blocked")
			}
		})
	}
}

func pairedDirectory(t *testing.T, serverURL string) string {
	t.Helper()
	directory := t.TempDir()
	u, err := url.Parse(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	creds := map[string]any{"access_token": "old-access", "refresh_token": "hatch_refresh:old-refresh", "api_url_v2": serverURL, "noise_host": u.Host, "untouched": "retained"}
	data, err := json.Marshal(creds)
	if err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string][]byte{"pairing.json": data, "identity.json": []byte(`{"mac":"00:11:22:33:44:55"}`), "sdk_token": []byte("sdk-secret\n")} {
		if err = os.WriteFile(filepath.Join(directory, name), contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return directory
}

func assertDispatchError(t *testing.T, err error, sent bool, stage string) {
	t.Helper()
	var failure *Error
	if !errors.As(err, &failure) || failure.Sent != sent || failure.Stage != stage {
		t.Fatalf("expected stage=%s sent=%v; got %#v", stage, sent, err)
	}
}

func peerChat(t *testing.T, w http.ResponseWriter, r *http.Request, onBody func([]byte), wait bool) {
	t.Helper()
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		t.Error(err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4 << 20)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	send, receive, err := peerHandshake(ctx, conn)
	if err != nil {
		t.Error(err)
		return
	}
	var a assembler
	for {
		_, data, e := conn.Read(ctx)
		if e != nil {
			t.Error(e)
			return
		}
		plain, e := receive.crypt(data, nil, true)
		if e != nil {
			t.Error(e)
			return
		}
		assembled, done, e := a.accept(plain)
		if e != nil {
			t.Error(e)
			return
		}
		if !done {
			continue
		}
		body, e := peerRequestBody(assembled)
		if e != nil {
			t.Error(e)
			return
		}
		onBody(body)
		break
	}
	if wait {
		_, _, _ = conn.Read(ctx)
		return
	}
	// Native acknowledgement envelope uses ServiceResponse.payload=1,
	// ServiceFrame.stream_id=1,response=3 and ApplicationResponse.{1,3,4}.
	body := []byte(`{"result":{"message_id":"native-message"}}`)
	response := uintField(nil, 1, 200)
	response = bytesField(response, 3, body)
	response = uintField(response, 4, 1)
	frame := uintField(nil, 1, 1)
	frame = bytesField(frame, 3, response)
	frames, e := chunksWithID(bytesField(nil, 1, frame), 99)
	if e != nil {
		t.Error(e)
		return
	}
	for _, f := range frames {
		encrypted, e := send.crypt(f, nil, false)
		if e != nil {
			t.Error(e)
			return
		}
		if e = conn.Write(ctx, websocket.MessageBinary, encrypted); e != nil {
			t.Error(e)
			return
		}
	}
}

// This peer delegates only the external Noise protocol to the upstream library.
// The fixed official Python SDK bytes in crypto_test independently establish
// compatibility; this peer exercises HTTP/WebSocket, cancellation and receipts.
func peerHandshake(ctx context.Context, conn *websocket.Conn) (send, receive *cipherState, err error) {
	static, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	peer, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: noise.NewCipherSuite(noise.DH25519, noise.CipherAESGCM, noise.HashSHA256),
		Pattern:     noise.HandshakeXX, StaticKeypair: static,
	})
	if err != nil {
		return nil, nil, err
	}
	kind, m1, err := conn.Read(ctx)
	if err != nil {
		return nil, nil, err
	}
	if kind != websocket.MessageBinary || len(m1) != 32 {
		return nil, nil, errProtocol
	}
	if _, _, _, err = peer.ReadMessage(nil, m1); err != nil {
		return nil, nil, err
	}
	m2, _, _, err := peer.WriteMessage(nil, nil)
	if err != nil {
		return nil, nil, err
	}
	if err = conn.Write(ctx, websocket.MessageBinary, m2); err != nil {
		return nil, nil, err
	}
	kind, m3, err := conn.Read(ctx)
	if err != nil {
		return nil, nil, err
	}
	if kind != websocket.MessageBinary {
		return nil, nil, errProtocol
	}
	_, initiatorSend, responderSend, err := peer.ReadMessage(nil, m3)
	if err != nil {
		return nil, nil, err
	}
	return &cipherState{state: responderSend}, &cipherState{state: initiatorSend}, nil
}

func peerRequestBody(data []byte) ([]byte, error) {
	outer, err := decode(data)
	if err != nil {
		return nil, err
	}
	raw, err := getBytes(outer, 2)
	if err != nil {
		return nil, err
	}
	frame, err := decode(raw)
	if err != nil {
		return nil, err
	}
	raw, err = getBytes(frame, 2)
	if err != nil {
		return nil, err
	}
	request, err := decode(raw)
	if err != nil {
		return nil, err
	}
	path, err := getBytes(request, 2)
	if err != nil || string(path) != "/chat/stream" {
		return nil, errProtocol
	}
	verb, err := getBytes(request, 1)
	if err != nil || string(verb) != "POST" {
		return nil, errProtocol
	}
	headers := map[string]string{}
	for _, f := range request[3] {
		h, e := decode(f.b)
		if e != nil {
			return nil, e
		}
		key, e := getBytes(h, 1)
		if e != nil {
			return nil, e
		}
		value, e := getBytes(h, 2)
		if e != nil {
			return nil, e
		}
		headers[strings.ToLower(string(key))] = string(value)
	}
	if headers["x-app-id"] != "hatch-web" || headers["x-request-id"] == "" || headers["content-type"] != "application/json" {
		return nil, errProtocol
	}
	return getBytes(request, 4)
}

func rotationHandler(t *testing.T, refreshes, sends *atomic.Int32) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/fetch_vms":
			if r.Header.Get("X-API-Version") != "1.0.0" {
				t.Error("API version missing")
			}
			if r.Header.Get("Authorization") == "Bearer old-access" {
				w.WriteHeader(401)
				return
			}
			if r.Header.Get("Authorization") != "Bearer new-access" {
				t.Error("unexpected device token")
				w.WriteHeader(401)
				return
			}
			_, _ = io.WriteString(w, `{"vm_list":[{"vm_id":"vm-A","vm_name":"A","vm_ws_url":"wss://unused.example/vm","vm_auth_token":"vm-token","default":true}]}`)
		case "/device_token/refresh":
			refreshes.Add(1)
			if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer hatch_refresh:old-refresh" {
				t.Error("wrong token refresh request")
			}
			var body map[string]string
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["device_id"] != "homelink-334455" || body["sdk_token"] != "sdk-secret" {
				t.Error("wrong device identity")
			}
			_, _ = io.WriteString(w, `{"payload":{"access_token":"new-access","refresh_token":"hatch_refresh:new-refresh"}}`)
		case "/v1/noise":
			if r.URL.Query().Get("vm_id") != "vm-A" || r.Header.Get("Authorization") != "Bearer vm-token" {
				t.Error("wrong Noise authentication")
			}
			peerChat(t, w, r, func(body []byte) {
				var request map[string]string
				if json.Unmarshal(body, &request) != nil || request["message"] != "payload" || request["session_id"] != "session-native" || request["output_modality"] != "text" {
					t.Errorf("wrong chat body %s", body)
				}
				sends.Add(1)
			}, false)
		default:
			w.WriteHeader(404)
		}
	})
}
