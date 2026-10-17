package mattermost

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	mm "github.com/mattermost/mattermost/server/public/model"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

func recoveryPeer(t *testing.T) *nativePeer {
	return &nativePeer{t: t, connections: make(chan map[string]string, 16), posts: make(chan *mm.Post, 16), uploads: make(chan []byte, 16), downloadStarted: make(chan struct{}), postStarted: make(chan struct{}), historyRequests: make(chan string, 16), history: historyFixtures()}
}

// Protects a lost native socket queue with a complete, unordered modified-post
// set and the exact durable millisecond boundary. Ingesting descending REST order
// reverses the conversation; advancing on HTTP failure drops its unaccepted
// history. Other tests exercise retained socket replay only. Real Core/SQLite and
// the native Grok HTTP peer expose dispatch order without a production seam.
func TestHistoryGapRecoversWholeSetInChronologicalOrder(t *testing.T) {
	p := recoveryPeer(t)
	peer := httptest.NewServer(p)
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "history.db")
	f := openFixture(t, path, peer)
	receive(t, p.connections)
	awaitCursor(t, f, 2)
	if text := receive(t, f.notifications); text != "native input" {
		t.Fatal("initial source missing")
	}
	f.close(t)
	p.resetConnection.Store(true)
	p.failHistory.Store(true)
	f = openFixture(t, path, peer)
	receive(t, p.connections)
	if since := receive(t, p.historyRequests); since != "1792195200122" {
		t.Fatalf("durable overlap boundary: %s", since)
	}
	state := awaitRecovery(t, f)
	awaitDegradedAfterClose(t, f, p)
	if state.ConnectionID != connectionID || state.NextSequence != 2 {
		t.Fatalf("failed history advanced socket: %+v", state)
	}
	p.failHistory.Store(false)
	state = awaitCursor(t, f, 1)
	if state.ConnectionID != newConnectionID || state.Recovery != nil {
		t.Fatalf("uncompleted history cursor: %+v", state)
	}
	if first, second := receive(t, f.notifications), receive(t, f.notifications); first != "older gap" || second != "newer gap" {
		t.Fatalf("history order: %q then %q", first, second)
	}
	rows, err := f.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(rows) != 3 {
		t.Fatalf("history missing or duplicated: %d %v", len(rows), err)
	}
}

// A full native since response cannot prove completeness. Keep its old cursor
// and every existing Core record, and apply a new recoveryEpoch once to skip the
// unaccepted native history. Reusing that epoch after reopen must resume the new
// native cursor. This protects operator recovery rather than a private helper.
func TestCappedHistoryStaysRetainedUntilOneTimeRecoveryEpoch(t *testing.T) {
	p := recoveryPeer(t)
	peer := httptest.NewServer(p)
	defer peer.Close()
	path := filepath.Join(t.TempDir(), "epoch.db")
	f := openFixture(t, path, peer)
	receive(t, p.connections)
	awaitCursor(t, f, 2)
	receive(t, f.notifications)
	f.close(t)
	p.resetConnection.Store(true)
	p.cappedHistory.Store(true)
	f = openFixture(t, path, peer)
	receive(t, p.connections)
	receive(t, p.historyRequests)
	state := awaitRecovery(t, f)
	awaitDegradedAfterClose(t, f, p)
	if state.ConnectionID != connectionID || state.NextSequence != 2 {
		t.Fatalf("capped history advanced: %+v", state)
	}
	assertOneSource(t, f)
	f.close(t)
	f = openFixture(t, path, peer, "manual-2026-10-17")
	query := receive(t, p.connections)
	if query["connection_id"] != "" || query["sequence_number"] != "0" {
		t.Fatalf("new epoch did not reset native history: %+v", query)
	}
	state = awaitCursor(t, f, 1)
	if state.Recovery != nil || state.RecoveryEpoch != "manual-2026-10-17" {
		t.Fatalf("epoch state: %+v", state)
	}
	assertOneSource(t, f)
	f.close(t)
	f = openFixture(t, path, peer, "manual-2026-10-17")
	query = receive(t, p.connections)
	if query["connection_id"] != newConnectionID || query["sequence_number"] != "1" {
		t.Fatalf("same epoch reset again: %+v", query)
	}
	assertOneSource(t, f)
}

func awaitDegradedAfterClose(t *testing.T, f *fixture, p *nativePeer) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if p.active.Load() == 0 && f.runtime.Connections()["/channels/mattermost/mattermost"] == model.Degraded {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("native history failure was not retained as degraded")
}

func assertOneSource(t *testing.T, f *fixture) {
	t.Helper()
	rows, err := f.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(rows) != 1 || rows[0].Snapshot.Source.EventID != postID {
		t.Fatalf("existing Core queue changed: %d %v", len(rows), err)
	}
}

func awaitRecovery(t *testing.T, f *fixture) cursor {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		state, _, err := common.ReadState[cursor](context.Background(), f.host.State(), "websocket-cursor")
		if err != nil {
			t.Fatal(err)
		}
		if state.Recovery != nil && len(state.Recovery.Channels) == 1 {
			return state
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("history progress not retained")
	return cursor{}
}

func historyFixtures() map[string]json.RawMessage {
	posts := map[string]any{}
	posts[gapPostID] = map[string]any{"id": gapPostID, "channel_id": roomID, "user_id": userID, "root_id": rootID, "message": "newer gap", "type": "", "create_at": 1792195200125, "update_at": 1792195200125}
	olderID := "eeeeeeeeeeeeeeeeeeeeeeeeee"
	posts[olderID] = map[string]any{"id": olderID, "channel_id": roomID, "user_id": userID, "root_id": rootID, "message": "older gap", "type": "", "create_at": 1792195200124, "update_at": 1792195200124}
	posts[postID] = map[string]any{"id": postID, "channel_id": roomID, "user_id": userID, "root_id": rootID, "message": "native input", "type": "", "file_ids": []string{fileID}, "create_at": 1792195200123, "update_at": 1792195200123}
	editedID := "iiiiiiiiiiiiiiiiiiiiiiiiii"
	deletedID := "xxxxxxxxxxxxxxxxxxxxxxxxxx"
	posts[editedID] = map[string]any{"id": editedID, "channel_id": roomID, "user_id": userID, "root_id": rootID, "message": "old post edited recently", "type": "", "create_at": 1792195100000, "update_at": 1792195200127}
	posts[deletedID] = map[string]any{"id": deletedID, "channel_id": roomID, "user_id": userID, "root_id": rootID, "message": "deleted gap", "type": "", "create_at": 1792195200124, "update_at": 1792195200128, "delete_at": 1792195200128}
	result := map[string]json.RawMessage{"complete": common.Data(map[string]any{"order": []string{gapPostID, postID, deletedID, olderID, editedID}, "posts": posts})}
	order := []string{}
	for n := range 1000 {
		id := fmt.Sprintf("%026d", n)
		order = append(order, id)
		posts[id] = map[string]any{"id": id, "channel_id": roomID, "user_id": userID, "root_id": rootID, "message": "capped native history", "type": "", "create_at": 1792195200200 + int64(n), "update_at": 1792195200200 + int64(n)}
	}
	result["capped"] = common.Data(map[string]any{"order": order, "posts": posts})
	return result
}

func TestRecoveryEpochValidation(t *testing.T) {
	for _, epoch := range []string{" ", "newline\n", strings.Repeat("a", 129), "非ASCII"} {
		if err := ValidateConfig(common.Data(Config{ServerURL: "https://mattermost.example", Token: model.SecretRef{Env: "TOKEN"}, RecoveryEpoch: epoch})); err == nil {
			t.Fatalf("invalid epoch accepted: %q", epoch)
		}
	}
}

// A bot can observe many authenticated channels before the operator binds one.
// Recording all their replay watermarks grows durable state with memberships.
// This keeps discovery observable while excluding unbound posts from the replay
// index; prior recovery tests use only configured conversations. No new seam.
func TestUnboundDiscoveryDoesNotGrowReplayWatermarks(t *testing.T) {
	p := recoveryPeer(t)
	p.unboundPost.Store(true)
	peer := httptest.NewServer(p)
	defer peer.Close()
	f := openFixture(t, filepath.Join(t.TempDir(), "discovery.db"), peer)
	receive(t, p.connections)
	state := awaitCursor(t, f, 2)
	if len(state.Watermarks) != 0 {
		t.Fatalf("unbound channel entered replay state: %+v", state.Watermarks)
	}
	discovered, err := f.runtime.Discoveries(context.Background(), "mattermost", 20)
	if err != nil || len(discovered) != 1 || discovered[0].ChatID != "vvvvvvvvvvvvvvvvvvvvvvvvvv" {
		t.Fatalf("discovery lost: %+v %v", discovered, err)
	}
	rows, err := f.store.ListInbound(context.Background(), model.ListInboundInput{StatusFilter: model.StatusFilter{Limit: 10}})
	if err != nil || len(rows) != 0 {
		t.Fatalf("unbound native post accepted: %d %v", len(rows), err)
	}
}
