package core_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
)

// These real MCP/HTTP/SQLite/native WeChat paths protect media ownership, byte
// integrity and Markdown attachment ordering. Reordering during core planning,
// bypassing upload immutability or accepting revoked capabilities fails here;
// adapter-only and storage-only coverage cannot see these compositions. The
// existing production upload/publication APIs need no test-only seam. Native
// peer fields follow the Tencent sources cited in integration_test.go.
func TestMCPUploadRichOrderAndNativeMediaDelivery(t *testing.T) {
	f := newRelayFixture(t, core.Options{})
	record := awaitInbound(t, f.store, model.AttemptAccepted)
	session := connectMCP(t, f)
	first := uploadFixture(t, f, session, record.Snapshot.Channel.ID, "one.bin", []byte("first-file"))
	second := uploadFixture(t, f, session, record.Snapshot.Channel.ID, "two.bin", []byte("second-file"))
	readBackUpload(t, f, session, record.Snapshot.Channel.ID, first, []byte("first-file"))
	input := map[string]any{"channel": record.Snapshot.Channel.ID, "text": "before [second](relanox://attachment/2) middle [first](relanox://attachment/1) after", "idempotencyKey": "ordered-files", "attachments": []map[string]string{{"mediaId": first}, {"mediaId": second}}}
	receipt := callTool[model.MessageReceipt](t, f, session, "relanox_send_message", input)
	if receipt.Status != model.Queued {
		t.Fatalf("media not queued: %#v", receipt)
	}
	awaitDelivery(t, f.store, receipt.DeliveryID, model.DeliverySent)
	outbound, err := f.store.GetOutbound(f.ctx, receipt.DeliveryID)
	if err != nil || outbound == nil {
		t.Fatalf("missing durable delivery: %v", err)
	}
	var ordered []string
	for _, chunk := range outbound.Chunks {
		if chunk.Media != nil {
			ordered = append(ordered, chunk.Media.ID)
		}
	}
	if len(ordered) != 2 || ordered[0] != second || ordered[1] != first {
		t.Fatalf("durable media order: %v", ordered)
	}
	files, rendered := nativeMediaSummary(t, f, len(outbound.Chunks))
	if len(files) != 2 || files[0] != "two.bin" || files[1] != "one.bin" || !strings.Contains(rendered, "before") || !strings.Contains(rendered, "after") || strings.Contains(rendered, "relanox://") {
		t.Fatalf("native ordering or text changed: %v %q", files, rendered)
	}
}

func nativeMediaSummary(t *testing.T, f *relayFixture, chunks int) ([]string, string) {
	t.Helper()
	var files []string
	var text strings.Builder
	for range chunks {
		select {
		case sent := <-f.sends:
			for _, item := range sent.Items {
				if item.File != nil {
					files = append(files, item.File.FileName)
				}
				if item.Text != nil {
					text.WriteString(item.Text.Text)
				}
			}
		case <-time.After(5 * time.Second):
			t.Fatal("native chunk missing")
		}
	}
	return files, text.String()
}

func uploadFixture(t *testing.T, f *relayFixture, session *mcp.ClientSession, channel, name string, data []byte) string {
	t.Helper()
	ticket := callTool[struct {
		URL     string            `json:"uploadUrl"`
		Method  string            `json:"method"`
		Headers map[string]string `json:"headers"`
	}](t, f, session, "relanox_create_upload", map[string]any{"channel": channel, "kind": "file", "mimeType": "application/octet-stream", "fileName": name, "size": len(data)})
	request, err := http.NewRequestWithContext(f.ctx, ticket.Method, ticket.URL, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range ticket.Headers {
		request.Header.Set(key, value)
	}
	response, err := f.relay.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct {
		ID string `json:"fileId"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || response.StatusCode != 200 || body.ID == "" {
		t.Fatalf("upload: %d %#v %v", response.StatusCode, body, err)
	}
	request, err = http.NewRequestWithContext(f.ctx, ticket.Method, ticket.URL, bytes.NewReader(bytes.Repeat([]byte("x"), len(data))))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	conflict, err := f.relay.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, conflict.Body)
	_ = conflict.Body.Close()
	if conflict.StatusCode != http.StatusConflict {
		t.Fatalf("immutable upload overwritten: %d", conflict.StatusCode)
	}
	return body.ID
}

func readBackUpload(t *testing.T, f *relayFixture, session *mcp.ClientSession, channel, id string, expected []byte) {
	t.Helper()
	result, err := session.CallTool(f.ctx, &mcp.CallToolParams{Name: "relanox_read_media", Arguments: map[string]string{"channel": channel, "mediaId": id}})
	if err != nil || result == nil || result.IsError || len(result.Content) != 1 {
		t.Fatalf("read media: %#v %v", result, err)
	}
	link, ok := result.Content[0].(*mcp.ResourceLink)
	if !ok {
		t.Fatalf("missing resource link: %#v", result.Content)
	}
	assertDownload(t, f.relay.Client(), link.URI, 200, expected)
}

func assertDownload(t *testing.T, client *http.Client, url string, code int, expected []byte) {
	t.Helper()
	response, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != code || code == 200 && (!bytes.Equal(data, expected) || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-Content-Type-Options") != "nosniff") {
		t.Fatalf("download: %d %q %v", response.StatusCode, data, err)
	}
}

func TestPublishedMediaRenewsWithoutRevokingPriorURLAndHonorsCurrentScope(t *testing.T) {
	f := newRelayFixture(t, core.Options{})
	record := awaitInbound(t, f.store, model.AttemptAccepted)
	session := connectMCP(t, f)
	id := uploadFixture(t, f, session, record.Snapshot.Channel.ID, "published.bin", []byte("published"))
	first, err := f.host.Media().Publish(f.ctx, record.Snapshot.Channel.ID, id, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.host.Media().Publish(f.ctx, record.Snapshot.Channel.ID, id, 6*time.Second)
	if err != nil || first == second {
		t.Fatalf("renewed capability missing: %v", err)
	}
	assertDownload(t, f.relay.Client(), first, 200, []byte("published"))
	assertDownload(t, f.relay.Client(), second, 200, []byte("published"))
	if err := f.store.RegisterConversations(f.ctx, nil); err != nil {
		t.Fatal(err)
	}
	assertDownload(t, f.relay.Client(), first, 404, nil)
	assertDownload(t, f.relay.Client(), second, 404, nil)
	result, err := session.CallTool(f.ctx, &mcp.CallToolParams{Name: "relanox_read_media", Arguments: map[string]string{"channel": record.Snapshot.Channel.ID, "mediaId": id}})
	if err != nil || result == nil || !result.IsError {
		t.Fatalf("revoked scope retained media access: %#v %v", result, err)
	}
}

// A retained plan belongs to its accepted input, even after its component has
// been disabled. Seeding the typed storage contract protects restart fallback
// without inventing a fake Preparer. Existing store recovery tests do not check
// what the real native agent receives after this transition.
func TestDisabledCapturedPreparationDispatchesOriginalNativeInput(t *testing.T) {
	f := newRelayFixture(t, core.Options{})
	record := awaitInbound(t, f.store, model.AttemptAccepted)
	<-f.notifications
	snapshot := record.Snapshot
	snapshot.Source.EventID = "retained-preparation"
	snapshot.RequestID = uuid.NewString()
	snapshot.AcceptedAt = time.Now().UTC().Truncate(time.Millisecond)
	snapshot.Text = "original retained audio description"
	snapshot.Preparation = []model.PreparationPlan{{ID: "tencent-speech", Options: json.RawMessage(`{"engine":"16k_zh","region":"ap-shanghai","secretId":{"env":"OLD_SECRET_ID"}}`)}}
	if _, err := f.store.AcceptInbound(f.ctx, snapshot, nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		retained, err := f.store.GetInbound(context.Background(), snapshot.RequestID)
		if err != nil {
			t.Fatal(err)
		}
		if retained.Dispatch.Status == model.AttemptAccepted {
			if len(retained.Preparation) != 1 || retained.Preparation[0].ID != "tencent-speech" || retained.Preparation[0].Status != "failed" || retained.Preparation[0].ErrorCode != "disabled" || !bytes.Equal(retained.Snapshot.Preparation[0].Options, snapshot.Preparation[0].Options) {
				t.Fatalf("captured preparation was changed: %#v", retained)
			}
			select {
			case notification := <-f.notifications:
				data, _ := json.Marshal(notification)
				if !strings.Contains(string(data), snapshot.Text) || strings.Contains(string(data), "OLD_SECRET_ID") {
					t.Fatalf("native fallback content: %s", data)
				}
			case <-time.After(time.Second):
				t.Fatal("native notification missing")
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("retained preparation did not settle")
}
