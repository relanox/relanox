package wecom

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// Native upload requires init/chunk/finish and zero-based chunk_index. A generic
// REST facade or one-based indexes fails these real socket exchanges; the crypto
// test does not exercise uploads. The peer only models external frames.
func TestNativeUploadChunksAndSingleReply(t *testing.T) {
	// Wire fixture source: @wecom/aibot-node-sdk 1.0.7 WSClient.uploadMedia.
	// https://github.com/WecomTeam/aibot-node-sdk
	bytesWanted := bytes.Repeat([]byte{42}, 600*1024)
	gotBytes := make(chan []byte, 1)
	gotReply := make(chan map[string]any, 1)
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		conn.SetReadLimit(1024 * 1024)
		var content []byte
		index := 0
		for {
			_, raw, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			var request frame
			if json.Unmarshal(raw, &request) != nil {
				t.Error("invalid frame")
				return
			}
			body := map[string]any{}
			switch request.Command {
			case "aibot_upload_media_init":
				var input struct {
					Type   string `json:"type"`
					Size   int    `json:"total_size"`
					Chunks int    `json:"total_chunks"`
				}
				json.Unmarshal(request.Body, &input)
				if input.Type != "voice" || input.Size != len(bytesWanted) || input.Chunks != 2 {
					t.Errorf("wrong init: %+v", input)
				}
				body["upload_id"] = "native-upload"
			case "aibot_upload_media_chunk":
				var input struct {
					ID    string `json:"upload_id"`
					Index int    `json:"chunk_index"`
					Data  string `json:"base64_data"`
				}
				json.Unmarshal(request.Body, &input)
				if input.ID != "native-upload" || input.Index != index {
					t.Errorf("incorrect native index: %+v", input)
				}
				part, err := base64.StdEncoding.DecodeString(input.Data)
				if err != nil {
					t.Error(err)
				}
				content = append(content, part...)
				index++
			case "aibot_upload_media_finish":
				body["media_id"] = "native-media"
				gotBytes <- content
			case "aibot_respond_msg":
				var input map[string]any
				json.Unmarshal(request.Body, &input)
				gotReply <- input
			default:
				t.Errorf("unexpected command: %s", request.Command)
			}
			response := map[string]any{"headers": map[string]string{"req_id": request.Headers.RequestID}, "errcode": 0, "body": body}
			if err = conn.Write(r.Context(), websocket.MessageText, common.Data(response)); err != nil {
				return
			}
		}
	}))
	defer peer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(peer.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	session := &socketSession{conn: conn, done: make(chan struct{}), pending: make(map[string]chan frame)}
	go session.read(ctx, make(chan frame, 1))
	mediaID, err := session.upload(ctx, model.StoredMedia{Reference: model.MediaReference{Kind: model.Audio, FileName: "voice.silk"}, Data: bytesWanted})
	if err != nil || mediaID != "native-media" {
		t.Fatalf("upload: %s %v", mediaID, err)
	}
	select {
	case actual := <-gotBytes:
		if !bytes.Equal(actual, bytesWanted) {
			t.Fatal("native bytes changed")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	_, err = session.call(ctx, "aibot_respond_msg", "selected-request", map[string]any{"msgtype": "voice", "voice": map[string]string{"media_id": mediaID}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case actual := <-gotReply:
		if actual["msgtype"] != "voice" {
			t.Fatal("reply type lost")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestQueuedSocketSendObservesCancellation(t *testing.T) {
	// The native ACK is deliberately withheld after a real write. A later queued
	// call must cancel without waiting for the unrelated request timeout. Upload
	// happy-path coverage does not exercise serialized queue cancellation.
	received := make(chan struct{})
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		if _, _, err = conn.Read(r.Context()); err != nil {
			return
		}
		close(received)
		for {
			if _, _, err = conn.Read(r.Context()); err != nil {
				return
			}
		}
	}))
	defer peer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(peer.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	session := &socketSession{conn: conn, done: make(chan struct{}), pending: make(map[string]chan frame)}
	go session.read(ctx, make(chan frame, 1))
	firstDone := make(chan error, 1)
	go func() { _, err := session.call(ctx, "aibot_send_msg", "held", map[string]any{}); firstDone <- err }()
	select {
	case <-received:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	waiting, stop := context.WithCancel(ctx)
	stop()
	queuedDone := make(chan error, 1)
	go func() {
		_, err := session.call(waiting, "aibot_send_msg", "cancelled", map[string]any{})
		queuedDone <- err
	}()
	select {
	case err := <-queuedDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled call: %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("cancelled send waited behind unrelated ACK")
	}
	cancel()
	conn.CloseNow()
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("active request did not stop")
	}
}
