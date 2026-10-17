package discord

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relanox/relanox/internal/model"
)

// Discord can expire a cached session during ordinary downtime. These tests
// protect bounded native before-pagination into the configured thread, followed
// by real Core/SQLite acceptance before clearing recovery. Removing the old
// anchor must fail visibly instead of crossing missing history; changing the
// administrator epoch must reset that boundary once while preserving saved
// work. Resume-only tests cannot exercise this independent REST recovery path.
// Protocol sources are the official gateway.mdx and message.mdx linked by the
// adapter. No new test seam is needed; the peer implements only native Discord.
type historyPeer struct {
	*nativePeer
	phase           atomic.Int32
	missing         bool
	noAnchor        bool
	oversized       bool
	boundaryMS      int64
	newScope        bool
	resumeAvailable bool
	historyCalls    atomic.Int32
}

func newHistoryPeer(t *testing.T, missing bool) (*historyPeer, *httptest.Server) {
	t.Helper()
	p := &historyPeer{nativePeer: &nativePeer{t: t, identifies: make(chan map[string]any, 16), sends: make(chan map[string]any, 8)}, missing: missing}
	peer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/gateway" && (p.phase.Load() > 0 || p.noAnchor) {
			p.expiredGateway(w, r)
			return
		}
		if r.URL.Path == "/channels/300/messages" && r.Method == http.MethodGet {
			p.history(w, r)
			return
		}
		if r.URL.Path == "/channels/301" {
			_, _ = io.WriteString(w, `{"id":"301","type":11,"parent_id":"400","guild_id":"500"}`)
			return
		}
		if r.URL.Path == "/channels/301/messages" && r.Method == http.MethodGet {
			p.historyCalls.Add(1)
			id := strconv.FormatUint(uint64(p.boundaryMS+1-1420070400000)<<22|1, 10)
			message := strings.Replace(historyMessage(id), `"channel_id":"300"`, `"channel_id":"301"`, 1)
			_, _ = io.WriteString(w, "["+message+"]")
			return
		}
		p.serve(w, r)
	}))
	p.origin = peer.URL
	return p, peer
}

func (p *historyPeer) expiredGateway(w http.ResponseWriter, r *http.Request) {
	socket, err := websocket.Accept(w, r, nil)
	if err != nil {
		p.t.Error(err)
		return
	}
	defer socket.CloseNow()
	ctx := r.Context()
	if socket.Write(ctx, websocket.MessageText, []byte(`{"op":10,"d":{"heartbeat_interval":100}}`)) != nil {
		return
	}
	_, raw, err := socket.Read(ctx)
	if err != nil {
		return
	}
	var envelope struct {
		Op   int            `json:"op"`
		Data map[string]any `json:"d"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		p.t.Error("invalid reconnect packet")
		return
	}
	p.identifies <- envelope.Data
	if envelope.Op == 6 && envelope.Data["session_id"] == "native-session" {
		if p.resumeAvailable {
			p.replayPreviouslyUnbound(ctx, socket)
			return
		}
		_ = socket.Write(ctx, websocket.MessageText, []byte(`{"op":9,"d":false,"s":null,"t":null}`))
		p.heartbeat(ctx, socket)
		return
	}
	if envelope.Op == 6 && envelope.Data["session_id"] == "fresh-session" {
		_ = socket.Write(ctx, websocket.MessageText, []byte(`{"op":0,"s":2,"t":"RESUMED","d":{}}`))
		p.heartbeat(ctx, socket)
		return
	}
	if envelope.Op != 2 {
		p.t.Errorf("unexpected fresh identify: %+v", envelope)
		return
	}
	resumeURL := strings.Replace(p.origin, "https:", "wss:", 1) + "/gateway"
	session := "fresh-session"
	if p.phase.Load() == 0 {
		session = "native-session"
	}
	_ = socket.Write(ctx, websocket.MessageText, []byte(`{"op":0,"s":0,"t":"READY","d":{"v":10,"session_id":"`+session+`","resume_gateway_url":"`+resumeURL+`","user":{"id":"100","bot":true}}}`))
	if !p.missing && !p.noAnchor && !p.newScope {
		message := `{"op":0,"s":1,"t":"MESSAGE_CREATE","d":` + historyMessage("700") + `}`
		_ = socket.Write(ctx, websocket.MessageText, []byte(message))
	}
	p.heartbeat(ctx, socket)
}

func (p *historyPeer) replayPreviouslyUnbound(ctx context.Context, socket *websocket.Conn) {
	id := strconv.FormatUint(uint64(p.boundaryMS+1-1420070400000)<<22|1, 10)
	message := strings.Replace(historyMessage(id), `"channel_id":"300"`, `"channel_id":"301"`, 1)
	_ = socket.Write(ctx, websocket.MessageText, []byte(`{"op":0,"s":2,"t":"MESSAGE_CREATE","d":`+message+`}`))
	_ = socket.Write(ctx, websocket.MessageText, []byte(`{"op":0,"s":3,"t":"RESUMED","d":{}}`))
	p.heartbeat(ctx, socket)
}

func historyMessage(id string) string {
	// guild_id is optional and normally absent from REST messages. The adapter
	// must validate the requested native channel without inventing that field.
	return `{"id":"` + id + `","channel_id":"300","type":0,"author":{"id":"200","bot":false},"content":"history ` + id + `","timestamp":"2026-10-17T00:00:00.000Z"}`
}

func (p *historyPeer) history(w http.ResponseWriter, r *http.Request) {
	p.historyCalls.Add(1)
	if r.URL.Query().Get("limit") != "100" || r.Header.Get("Authorization") != "Bot native-token" {
		p.t.Error("native history bounds or authorization missing")
	}
	w.Header().Set("Content-Type", "application/json")
	before := r.URL.Query().Get("before")
	if p.noAnchor {
		p.boundaryHistory(w)
		return
	}
	if p.oversized {
		p.oversizedHistory(w, before)
		return
	}
	if p.missing {
		if before == "" {
			_, _ = io.WriteString(w, "["+historyMessage("602")+","+historyMessage("601")+"]")
		} else {
			_, _ = io.WriteString(w, "[]")
		}
		return
	}
	switch before {
	case "":
		rows := make([]string, 0, 100)
		for id := 700; id >= 601; id-- {
			rows = append(rows, historyMessage(strconv.Itoa(id)))
		}
		_, _ = io.WriteString(w, "["+strings.Join(rows, ",")+"]")
	case "601":
		_, _ = io.WriteString(w, "["+historyMessage("600")+"]")
	default:
		p.t.Errorf("native before-pagination changed: %s", before)
		w.WriteHeader(400)
	}
}

func (p *historyPeer) boundaryHistory(w http.ResponseWriter) {
	// Native fixture IDs use Discord's documented snowflake bit layout, not
	// the adapter's history helpers. One post precedes the persisted start and
	// one follows it, so a lost session without an anchor has a finite boundary.
	newID := strconv.FormatUint(uint64(p.boundaryMS+1000-1420070400000)<<22|1, 10)
	oldID := strconv.FormatUint(uint64(p.boundaryMS-1000-1420070400000)<<22|1, 10)
	newMessage := strings.Replace(historyMessage(newID), "2026-10-17T00:00:00.000Z", time.UnixMilli(p.boundaryMS+1000).UTC().Format(time.RFC3339Nano), 1)
	oldMessage := strings.Replace(historyMessage(oldID), "2026-10-17T00:00:00.000Z", time.UnixMilli(p.boundaryMS-1000).UTC().Format(time.RFC3339Nano), 1)
	_, _ = io.WriteString(w, "["+newMessage+","+oldMessage+"]")
}

func (p *historyPeer) oversizedHistory(w http.ResponseWriter, before string) {
	newest := 2700
	if before != "" {
		id, err := strconv.Atoi(before)
		if err != nil {
			p.t.Error(err)
			w.WriteHeader(400)
			return
		}
		newest = id - 1
	}
	rows := make([]string, 0, 100)
	for id := newest; id > newest-100; id-- {
		rows = append(rows, historyMessage(strconv.Itoa(id)))
	}
	_, _ = io.WriteString(w, "["+strings.Join(rows, ",")+"]")
}

func awaitDiscordState(t *testing.T, f *discordRelay, predicate func(gatewayState) bool) gatewayState {
	t.Helper()
	deadline := time.Now().Add(7 * time.Second)
	for time.Now().Before(deadline) {
		state := discordCheckpoint(t, f)
		if predicate(state) {
			return state
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("native gateway did not reach durable recovery checkpoint")
	return gatewayState{}
}

func seedDiscordAnchor(t *testing.T, p *historyPeer, peer *httptest.Server, path string) gatewayState {
	t.Helper()
	first := startDiscordRelay(t, peer, path, false)
	state := awaitDiscordState(t, first, func(state gatewayState) bool { return state.Anchors["300"] == "600" })
	first.close(t)
	p.phase.Store(1)
	return state
}

func TestExpiredSessionBackfillsConfiguredThreadBeforeAdvancing(t *testing.T) {
	p, peer := newHistoryPeer(t, false)
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "discord.db")
	seedDiscordAnchor(t, p, peer, path)
	last := startDiscordRelay(t, peer, path, false)
	defer last.close(t)
	state := awaitDiscordState(t, last, func(state gatewayState) bool {
		return state.SessionID == "fresh-session" && !state.Recovering && hasSequence(state, 1)
	})
	if state.Anchors["300"] != "700" || p.historyCalls.Load() != 2 {
		t.Fatalf("native bounded history did not reach anchor: %+v calls=%d", state, p.historyCalls.Load())
	}
	records, err := last.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 200}, Recent: true})
	if err != nil || len(records) != 101 {
		t.Fatalf("history lost messages or duplicated live replay: %d %v", len(records), err)
	}
	byID := map[string]model.InboundSnapshot{}
	for _, record := range records {
		byID[record.Snapshot.Source.EventID] = record.Snapshot
	}
	for _, id := range []string{"601", "700"} {
		in := byID[id]
		if in.Text != "history "+id || in.Target.ChatID != "400" || in.Target.ThreadID != "300" || in.Endpoint.ID != "grok" {
			t.Fatalf("recovered native identity or routing: %+v", in)
		}
	}
	if !byID["600"].AcceptedAt.Before(byID["601"].AcceptedAt) || byID["601"].AcceptedAt.After(byID["700"].AcceptedAt) {
		t.Fatal("history was not accepted oldest first")
	}
}

func TestMissingAnchorRequiresExplicitOneTimeRecoveryEpoch(t *testing.T) {
	p, peer := newHistoryPeer(t, true)
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "discord.db")
	seedDiscordAnchor(t, p, peer, path)
	failed := startDiscordRelay(t, peer, path, false)
	awaitDiscordState(t, failed, func(state gatewayState) bool {
		return state.SessionID == "fresh-session" && state.Recovering && p.historyCalls.Load() >= 2
	})
	records, err := failed.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 {
		t.Fatalf("missing anchor silently crossed unavailable history: %d %v", len(records), err)
	}
	failed.close(t)
	rescued := startDiscordRelay(t, peer, path, false, fixtureOptions{Epoch: "operator-rescue-1"})
	state := awaitDiscordState(t, rescued, func(state gatewayState) bool {
		return state.RecoveryEpoch == "operator-rescue-1" && state.SessionID == "fresh-session" && !state.Recovering
	})
	if state.Anchors["300"] != "" || p.historyCalls.Load() != 2 {
		t.Fatalf("explicit reset retained gap or rescanned: %+v calls=%d", state, p.historyCalls.Load())
	}
	started := state.StartedAtMS
	rescued.close(t)
	again := startDiscordRelay(t, peer, path, false, fixtureOptions{Epoch: "operator-rescue-1"})
	defer again.close(t)
	state = awaitDiscordState(t, again, func(state gatewayState) bool { return hasSequence(state, 2) })
	if state.StartedAtMS != started || state.RecoveryEpoch != "operator-rescue-1" || p.historyCalls.Load() != 2 {
		t.Fatalf("unchanged epoch reset history again: %+v", state)
	}
	records, err = again.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 || records[0].Snapshot.Text != "native input" {
		t.Fatalf("explicit history reset discarded committed work: %d %v", len(records), err)
	}
}

func TestRecoveryEpochRejectsWhitespaceAndControlCharacters(t *testing.T) {
	for _, epoch := range []string{" ", "epoch value", "epoch\nvalue", strings.Repeat("a", 129)} {
		raw := []byte(fmt.Sprintf(`{"botToken":{"env":"BOT"},"recoveryEpoch":%q}`, epoch))
		if err := ValidateConfig(raw); err == nil {
			t.Fatalf("invalid operator recovery epoch accepted: %q", epoch)
		}
	}
}

func TestExpiredSessionWithoutAnchorUsesPersistedConnectionBoundary(t *testing.T) {
	p, peer := newHistoryPeer(t, false)
	p.noAnchor = true
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "discord.db")
	first := startDiscordRelay(t, peer, path, false)
	initial := awaitDiscordState(t, first, func(state gatewayState) bool { return state.SessionID == "native-session" })
	first.close(t)
	p.boundaryMS = initial.StartedAtMS
	p.phase.Store(1)
	last := startDiscordRelay(t, peer, path, false)
	defer last.close(t)
	awaitDiscordState(t, last, func(state gatewayState) bool { return state.SessionID == "fresh-session" && !state.Recovering })
	records, err := last.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 || p.historyCalls.Load() != 1 {
		t.Fatalf("unanchored recovery crossed the persisted start: count=%d calls=%d %v", len(records), p.historyCalls.Load(), err)
	}
	if records[0].Snapshot.ReceivedAt.Before(time.UnixMilli(initial.StartedAtMS)) {
		t.Fatal("unanchored recovery accepted pre-start history")
	}
}

func TestHistoryBeyondTwoThousandMessagesRetainsRecoveryCheckpoint(t *testing.T) {
	p, peer := newHistoryPeer(t, false)
	p.oversized = true
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "discord.db")
	seedDiscordAnchor(t, p, peer, path)
	last := startDiscordRelay(t, peer, path, false)
	defer last.close(t)
	state := awaitDiscordState(t, last, func(state gatewayState) bool { return state.Recovering && p.historyCalls.Load() >= 20 })
	if state.Anchors["300"] != "600" || p.historyCalls.Load() != 20 {
		t.Fatalf("history exceeded its native page bound: %+v calls=%d", state, p.historyCalls.Load())
	}
	records, err := last.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 {
		t.Fatalf("unresolved bounded history was partly accepted: %d %v", len(records), err)
	}
}

func TestNewBindingDoesNotResurrectPreviouslyUnboundHistory(t *testing.T) {
	p, peer := newHistoryPeer(t, false)
	p.newScope = true
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "discord.db")
	old := seedDiscordAnchor(t, p, peer, path)
	p.boundaryMS = old.StartedAtMS
	newScope := fixtureOptions{Bindings: []model.Binding{{AccountID: "discord", ChatID: "400", ThreadID: "301", EndpointID: "grok"}}}
	last := startDiscordRelay(t, peer, path, false, newScope)
	defer last.close(t)
	state := awaitDiscordState(t, last, func(state gatewayState) bool { return state.SessionID == "fresh-session" && !state.Recovering })
	if state.BoundSinceMS["301"] <= old.StartedAtMS || state.Anchors["300"] != "" || p.historyCalls.Load() != 1 {
		t.Fatalf("new binding reused old receive coverage: %+v", state)
	}
	records, err := last.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 || records[0].Snapshot.Source.EventID != "600" {
		t.Fatalf("new binding resurrected previously unauthorized history: %d %v", len(records), err)
	}
}

func TestResumableSessionDoesNotReplayPreBindingPostsIntoNewScope(t *testing.T) {
	p, peer := newHistoryPeer(t, false)
	p.newScope = true
	p.resumeAvailable = true
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "discord.db")
	old := seedDiscordAnchor(t, p, peer, path)
	p.boundaryMS = old.StartedAtMS
	newScope := fixtureOptions{Bindings: []model.Binding{{AccountID: "discord", ChatID: "400", ThreadID: "301", EndpointID: "grok"}}}
	last := startDiscordRelay(t, peer, path, false, newScope)
	defer last.close(t)
	state := awaitDiscordState(t, last, func(state gatewayState) bool { return hasSequence(state, 3) })
	if state.SessionID != "native-session" || state.Anchors["301"] != "" || p.historyCalls.Load() != 0 {
		t.Fatalf("resumable native session lost its new binding boundary: %+v", state)
	}
	records, err := last.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(records) != 1 || records[0].Snapshot.Source.EventID != "600" {
		t.Fatalf("resume resurrected previously unauthorized history: %d %v", len(records), err)
	}
}
