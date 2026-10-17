package speech_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/agentmcp"
	"github.com/relanox/relanox/internal/agents/grok"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/channels/wechat"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/speech"
	"github.com/relanox/relanox/internal/storage"
)

// This recovery uses real core, native components, Tencent SDK HTTP and SQLite
// closed/reopened between acceptance and preparation. It protects captured
// credentials/options and original media while exposing derived text through
// both native notification and scoped reads. Replanning on restart, mutating
// originals or losing per-clip fallback fail here. Provider-only tests cannot
// see persistence/projection. No fake Preparer or routing/persistence peer exists.
// WeChat fixture numbering: https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts
func TestRetainedSpeechPlanSurvivesRestartAndProjectsDerivedContent(t *testing.T) {
	peers := newPreparationPeers(t)
	asr := newASRPeer(t, `{"Response":{"Result":"spoken English","WordList":null,"RequestId":"41ed9283-0c09-46fb-917b-0b83fa95f0be"}}`, false)
	t.Setenv("OLD_ASR_ID", "initial-id")
	t.Setenv("OLD_ASR_KEY", "initial-key")
	path := filepath.Join(t.TempDir(), "relay.db")
	first := startPreparationRelay(t, peers, path, speechConfig(), asr.client())
	select {
	case <-peers.initialDispatch:
	case <-time.After(3 * time.Second):
		t.Fatal("native initial dispatch did not start")
	}
	records, err := first.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 5}})
	if err != nil || len(records) != 1 {
		t.Fatalf("initial native input: %#v %v", records, err)
	}
	input := model.IngestInput{Source: model.SourceKey{Channel: model.WeChat, AccountID: "wechat", EventID: "retained-audio"}, SenderID: "alice", Text: "original caption", Target: records[0].Snapshot.Target, ReceivedAt: time.Now(), Attachments: []model.MediaUpload{
		{Kind: model.Audio, MIMEType: "audio/wav", FileName: "voice.wav", Data: []byte("native audio bytes")},
		{Kind: model.Audio, MIMEType: "audio/ogg", FileName: "vorbis.ogg", Data: []byte("OggS---unsupported Vorbis")},
	}}
	receipt, err := first.host.Ingest(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	first.runtime.SetAccepting(false)
	accepted, err := first.store.GetInbound(context.Background(), receipt.RequestID)
	if err != nil || accepted == nil || len(accepted.Snapshot.Preparation) != 1 || len(accepted.Preparation) != 0 {
		t.Fatalf("preparation not captured before shutdown: %#v %v", accepted, err)
	}
	first.close()
	t.Setenv("OLD_ASR_ID", "rotated-retained-id")
	t.Setenv("OLD_ASR_KEY", "rotated-retained-key")
	changed := speechConfig()
	changed.EngineModelType, changed.Region = "8k_zh", "ap-guangzhou"
	changed.SecretID, changed.SecretKey = model.SecretRef{Env: "NEW_ASR_ID"}, model.SecretRef{Env: "NEW_ASR_KEY"}
	second := startPreparationRelay(t, peers, path, changed, asr.client())
	completed := awaitPrepared(t, second.store, receipt.RequestID)
	assertRetainedPreparation(t, accepted, completed)
	request := <-asr.requests
	if request.Body.Engine != "16k_en" || request.Header.Get("X-TC-Region") != "ap-shanghai" || !strings.Contains(request.Header.Get("Authorization"), "Credential=rotated-retained-id/") {
		t.Fatalf("restart redirected captured ASR options: %#v", request)
	}
	assertPreparedProjections(t, peers, second, completed)
	media, err := second.store.GetMedia(context.Background(), completed.Snapshot.Channel.ID, completed.Snapshot.Attachments[0].ID)
	if err != nil || media == nil || !bytes.Equal(media.Data, []byte("native audio bytes")) {
		t.Fatalf("preparation changed original media: %#v %v", media, err)
	}
}

func assertRetainedPreparation(t *testing.T, accepted, completed *model.InboundRecord) {
	t.Helper()
	if completed.Snapshot.Text != "original caption" || len(completed.Snapshot.Attachments) != 2 || !bytes.Equal(completed.Snapshot.Preparation[0].Options, accepted.Snapshot.Preparation[0].Options) || len(completed.Preparation) != 1 || completed.Preparation[0].Status != "completed" {
		t.Fatalf("original snapshot or preparation lost: %#v", completed)
	}
	var result struct {
		Transcriptions []speech.Transcription `json:"transcriptions"`
	}
	output := completed.Preparation[0].Output
	if output == nil || json.Unmarshal(output.Data, &result) != nil || len(result.Transcriptions) != 2 || result.Transcriptions[0].Text != "spoken English" || result.Transcriptions[1].ErrorCode != "unsupported_format" {
		t.Fatalf("mixed clip result lost: %#v", output)
	}
}

func assertPreparedProjections(t *testing.T, peers *preparationPeers, relay *preparationRelay, record *model.InboundRecord) {
	t.Helper()
	host, err := relay.runtime.AgentHost(model.Grok)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := host.ForPrincipal(context.Background(), model.Principal{Subject: "grok", EndpointIDs: []string{"grok"}})
	if err != nil {
		t.Fatal(err)
	}
	messages, err := scope.ReadMessages(context.Background(), model.ReadMessagesInput{RequestID: record.Snapshot.RequestID})
	if err != nil || len(messages) != 1 || !strings.Contains(messages[0].Text, "spoken English") || len(messages[0].Extensions["speech-tencent"]) == 0 {
		t.Fatalf("prepared scoped read: %#v %v", messages, err)
	}
	select {
	case content := <-peers.notifications:
		if !strings.Contains(content, "original caption") || !strings.Contains(content, "spoken English") || strings.Contains(content, "rotated-retained-key") || strings.Contains(content, "OLD_ASR_KEY") {
			t.Fatalf("unsafe native prepared notification: %s", content)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("prepared native notification missing")
	}
}

type preparationPeers struct {
	wechat          *httptest.Server
	routine         *httptest.Server
	initialDispatch chan struct{}
	notifications   chan string
}

func newPreparationPeers(t *testing.T) *preparationPeers {
	t.Helper()
	p := &preparationPeers{initialDispatch: make(chan struct{}), notifications: make(chan string, 8)}
	var firstInput, firstDispatch atomic.Bool
	p.wechat = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if r.URL.Path != "/ilink/bot/getupdates" {
			t.Errorf("unexpected native channel request %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		if firstInput.CompareAndSwap(false, true) {
			_, _ = io.WriteString(w, `{"ret":0,"msgs":[{"message_id":1,"from_user_id":"alice","to_user_id":"bot","message_type":1,"message_state":2,"context_token":"native-private-context","item_list":[{"type":1,"text_item":{"text":"initial input"}}]}],"get_updates_buf":"saved-cursor"}`)
			return
		}
		<-r.Context().Done()
	}))
	p.routine = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var envelope struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if firstDispatch.CompareAndSwap(false, true) {
			close(p.initialDispatch)
			<-r.Context().Done()
			return
		}
		p.notifications <- envelope.Content
		// Routine success receipt: https://cursor.com/help/grok-bot/routines#where-do-the-webhook-url-and-key-live-and-what-does-a-200-mean
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(p.wechat.Close)
	t.Cleanup(p.routine.Close)
	return p
}

type preparationRelay struct {
	runtime *core.Runtime
	store   *storage.Store
	host    model.ChannelHost
	close   func()
}

func startPreparationRelay(t *testing.T, peers *preparationPeers, path string, speechCfg config.Speech, asrClient *http.Client) *preparationRelay {
	t.Helper()
	account := model.AccountConfig{ID: "wechat", Channel: model.WeChat, AllowedSenders: []string{"alice"}, Config: common.Data(wechat.Config{BotID: "bot", BotToken: model.SecretRef{Env: "WECHAT_TOKEN"}, APIBaseURL: peers.wechat.URL, CDNBaseURL: peers.wechat.URL + "/c2c", AllowInsecureLoopback: true})}
	endpoint := model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: common.Data(grok.Config{MCP: agentmcp.Config{Auth: "bearer", Token: model.SecretRef{Env: "MCP_TOKEN"}}, RoutineURL: model.SecretRef{Env: "ROUTINE_URL"}, RoutineAuthorization: model.SecretRef{Env: "ROUTINE_AUTH"}})}
	cfg := config.Config{Accounts: []model.AccountConfig{account}, Endpoints: []model.EndpointConfig{endpoint}, Bindings: []model.Binding{{AccountID: "wechat", ChatID: "alice", EndpointID: "grok"}}, Storage: config.Storage{Driver: "sqlite", Path: path}, HTTP: config.HTTP{PublicURL: "http://127.0.0.1:8787"}, Queue: config.Queue{Concurrency: 1, PollIntervalMS: 5}, Speech: &speechCfg}
	resolve := func(ref model.SecretRef) (string, error) {
		if value := map[string]string{"WECHAT_TOKEN": "public-token", "MCP_TOKEN": "mcp-token", "ROUTINE_URL": peers.routine.URL, "ROUTINE_AUTH": "Bearer routine-token"}[ref.Env]; value != "" {
			return value, nil
		}
		return cfg.ResolveSecret(ref)
	}
	preparer, err := speech.New(speechCfg, speech.Options{ResolveSecret: resolve, HTTPClient: asrClient})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	store, err := storage.Open(ctx, cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := core.New(cfg, store, core.Options{Preparers: []model.Preparer{preparer}})
	if err != nil {
		t.Fatal(err)
	}
	host, err := runtime.ChannelHost("wechat")
	if err != nil {
		t.Fatal(err)
	}
	channel, err := wechat.New(host, account, common.Options{HTTPClient: peers.wechat.Client(), ResolveSecret: resolve})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.AttachChannel("wechat", channel); err != nil {
		t.Fatal(err)
	}
	attachPreparationAgent(t, runtime, endpoint, peers, resolve)
	if err = runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	closeRelay := func() {
		once.Do(func() {
			cancel()
			ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if err := runtime.Close(ctx); err != nil {
				t.Error(err)
			}
			_ = store.Close()
		})
	}
	t.Cleanup(closeRelay)
	return &preparationRelay{runtime: runtime, store: store, host: host, close: closeRelay}
}

func attachPreparationAgent(t *testing.T, runtime *core.Runtime, endpoint model.EndpointConfig, peers *preparationPeers, resolve func(model.SecretRef) (string, error)) {
	t.Helper()
	host, err := runtime.AgentHost(model.Grok)
	if err != nil {
		t.Fatal(err)
	}
	agent, err := grok.New(endpoint, agentmcp.Dependencies{Host: host, ResolveSecret: resolve, HTTPClient: peers.routine.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.AttachAgent("grok", agent); err != nil {
		t.Fatal(err)
	}
}

func awaitPrepared(t *testing.T, store *storage.Store, id string) *model.InboundRecord {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		record, err := store.GetInbound(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if record != nil && record.Dispatch.Status == model.AttemptAccepted {
			return record
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("retained preparation did not dispatch")
	return nil
}
