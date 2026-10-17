// Package musewire connects an already-paired Muse device directly from Go.
// Pairing itself remains a separate device enrollment operation. No local shell
// commands or streamed agent replies are registered by this client.
package musewire

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// Options selects a paired device and optionally a VM and session. HTTPClient
// supports the deployment's TLS roots, proxies and transport instrumentation.
type Options struct {
	CredentialsDirectory string
	VMID                 string
	SessionID            string
	HTTPClient           *http.Client
}

// Error records whether a chat request may have reached Muse. Unsent operations
// can be retried; Sent errors require explicit recovery to avoid duplicate turns.
type Error struct {
	Stage      string
	Sent       bool
	HTTPStatus int
	Cause      error
}

func (e *Error) Error() string { return "muse: " + e.Stage + " failed" }

func (e *Error) Unwrap() error { return e.Cause }

// Acknowledgement confirms Muse accepted the notification, not that an agent
// delivered a final answer through Relanox MCP.
type Acknowledgement struct {
	MessageID        string
	ReplyToMessageID string
}

func dispatchError(stage string, sent bool, err error) *Error {
	out := &Error{Stage: stage, Sent: sent, Cause: err}
	var receipt httpError
	if errors.As(err, &receipt) {
		out.HTTPStatus = receipt.status
	}
	return out
}

// SendMessage serializes refresh and send operations sharing a credential
// directory, with cancellation while waiting and during every network stage.
func SendMessage(ctx context.Context, options Options, message string) (Acknowledgement, error) {
	var zero Acknowledgement
	if strings.TrimSpace(message) == "" || options.CredentialsDirectory == "" {
		return zero, dispatchError("configuration", false, errCredentials)
	}
	body := map[string]string{"message": message, "output_modality": "text"}
	if options.SessionID != "" {
		body["session_id"] = options.SessionID
	}
	encoded, err := json.Marshal(body)
	if err != nil || len(encoded) > 261120 {
		return zero, dispatchError("body", false, errProtocol)
	}
	release, err := lockDirectory(ctx, options.CredentialsDirectory)
	if err != nil {
		return zero, dispatchError("queue", false, err)
	}
	defer release()
	if err = ctx.Err(); err != nil {
		return zero, dispatchError("queue", false, err)
	}
	creds, err := loadCredentials(options.CredentialsDirectory)
	if err != nil {
		return zero, dispatchError("credentials", false, err)
	}
	client := http.DefaultClient
	if options.HTTPClient != nil {
		client = options.HTTPClient
	}
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for attempt := 0; attempt < 2; attempt++ {
		vms, e := listVMs(ctx, &copyClient, options.CredentialsDirectory, &creds)
		if e != nil {
			return zero, dispatchError("account", false, e)
		}
		selected, e := selectVM(vms, options.VMID)
		if e != nil {
			return zero, dispatchError("vm", false, e)
		}
		conn, send, receive, e := connect(ctx, &copyClient, creds, selected)
		if e != nil {
			var receipt httpError
			if attempt == 0 && errors.As(e, &receipt) && (receipt.status == 401 || receipt.status == 403) {
				continue
			}
			return zero, dispatchError("connect", false, e)
		}
		defer conn.CloseNow()
		return sendChat(ctx, conn, send, receive, encoded)
	}
	return zero, dispatchError("connect", false, errProtocol)
}

func selectVM(vms []vm, id string) (vm, error) {
	for _, v := range vms {
		if id != "" && v.ID == id || id == "" && v.Default {
			return v, nil
		}
	}
	if id == "" && len(vms) > 0 {
		return vms[0], nil
	}
	return vm{}, errors.New("muse: requested VM unavailable")
}

func connect(ctx context.Context, client *http.Client, creds credentials, vm vm) (*websocket.Conn, *cipherState, *cipherState, error) {
	host := creds.NoiseHost
	if host == "" {
		host = "hatch.metaaivm.com"
	}
	if strings.ContainsAny(host, " \t\r\n/@?#\\") {
		return nil, nil, nil, errCredentials
	}
	u := url.URL{Scheme: "wss", Host: host, Path: "/v1/noise"}
	query := url.Values{"vm_id": {vm.ID}}
	u.RawQuery = query.Encode()
	bounded, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(bounded, u.String(), &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Authorization": {"Bearer " + vm.Token}, "User-Agent": {"relanox-muse/0.1.0"}}, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		if resp != nil {
			return nil, nil, nil, httpError{resp.StatusCode}
		}
		return nil, nil, nil, errors.New("muse: websocket unavailable")
	}
	conn.SetReadLimit(4 << 20)
	failed := true
	defer func() {
		if failed {
			_ = conn.CloseNow()
		}
	}()
	h := newHandshake()
	m1, err := h.message1(nil)
	if err != nil {
		return nil, nil, nil, err
	}
	if err = conn.Write(bounded, websocket.MessageBinary, m1); err != nil {
		return nil, nil, nil, err
	}
	kind, m2, err := conn.Read(bounded)
	if err != nil {
		return nil, nil, nil, err
	}
	if kind != websocket.MessageBinary {
		return nil, nil, nil, errProtocol
	}
	if err = h.message2(m2); err != nil {
		return nil, nil, nil, err
	}
	m3, send, receive, err := h.finish(nil)
	if err != nil {
		return nil, nil, nil, err
	}
	if err = conn.Write(bounded, websocket.MessageBinary, m3); err != nil {
		return nil, nil, nil, err
	}
	failed = false
	return conn, send, receive, nil
}

func sendChat(ctx context.Context, conn *websocket.Conn, send, receive *cipherState, body []byte) (Acknowledgement, error) {
	var zero Acknowledgement
	bounded, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := bounded.Err(); err != nil {
		return zero, dispatchError("send", false, err)
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return zero, dispatchError("send", false, err)
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	requestID := fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(id[:4]), hex.EncodeToString(id[4:6]), hex.EncodeToString(id[6:8]), hex.EncodeToString(id[8:10]), hex.EncodeToString(id[10:]))
	chunks, err := frameChunks(requestFrame(1, "/chat/stream", body, requestID))
	if err != nil {
		return zero, dispatchError("send", false, err)
	}
	sent := false
	for _, chunk := range chunks {
		if err = bounded.Err(); err != nil {
			return zero, dispatchError("send", sent, err)
		}
		ciphertext, e := send.crypt(chunk, nil, false)
		if e != nil {
			return zero, dispatchError("send", sent, e)
		}
		sent = true
		if e = conn.Write(bounded, websocket.MessageBinary, ciphertext); e != nil {
			return zero, dispatchError("send", true, e)
		}
	}
	ack, err := readAcknowledgement(bounded, conn, receive)
	if err != nil {
		return zero, dispatchError("acknowledgement", true, err)
	}
	return ack, nil
}

func readAcknowledgement(ctx context.Context, conn *websocket.Conn, receive *cipherState) (Acknowledgement, error) {
	var zero Acknowledgement
	var decoder assembler
	var body []byte
	status := 0
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			return zero, err
		}
		if kind != websocket.MessageBinary {
			return zero, errProtocol
		}
		plain, err := receive.crypt(data, nil, true)
		if err != nil {
			return zero, err
		}
		assembled, done, err := decoder.accept(plain)
		if err != nil {
			return zero, err
		}
		if !done {
			continue
		}
		frame, err := parseResponse(assembled)
		if err != nil {
			return zero, err
		}
		if frame.id != 1 {
			continue
		}
		if frame.kind == 5 {
			return zero, errors.New("muse: request reset")
		}
		if frame.kind == 3 {
			if status != 0 {
				return zero, errProtocol
			}
			status = frame.status
		} else if status == 0 {
			return zero, errProtocol
		}
		body = append(body, frame.body...)
		if len(body) > 1<<20 {
			return zero, errProtocol
		}
		if frame.end {
			if status < 200 || status >= 300 {
				return zero, httpError{status}
			}
			return parseAcknowledgement(body)
		}
	}
}

func parseAcknowledgement(data []byte) (Acknowledgement, error) {
	var raw struct {
		MessageID string          `json:"message_id"`
		ReplyID   string          `json:"reply_to_message_id"`
		Result    json.RawMessage `json:"result"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return Acknowledgement{}, errProtocol
	}
	if len(raw.Result) > 0 {
		return parseAcknowledgementResult(raw.Result)
	}
	if raw.MessageID == "" {
		return Acknowledgement{}, errProtocol
	}
	return Acknowledgement{MessageID: raw.MessageID, ReplyToMessageID: raw.ReplyID}, nil
}

func parseAcknowledgementResult(data []byte) (Acknowledgement, error) {
	var result struct {
		MessageID string `json:"message_id"`
		ReplyID   string `json:"reply_to_message_id"`
	}
	if json.Unmarshal(data, &result) != nil || result.MessageID == "" {
		return Acknowledgement{}, errProtocol
	}
	return Acknowledgement{MessageID: result.MessageID, ReplyToMessageID: result.ReplyID}, nil
}
