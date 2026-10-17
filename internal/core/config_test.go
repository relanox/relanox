package core_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/relanox/relanox/internal/core"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// Direct typed construction and configuration snapshots are public boundaries.
// An omitempty tag can erase an explicitly empty narrowing allowlist and grant
// account-wide inheritance. JSON decode-only validation misses this roundtrip;
// a real store suffices and no routing substitute or special seam is needed.
func TestTypedRuntimeConstructionPreservesBindingAllowlistSemantics(t *testing.T) {
	cfg := relayConfig(t, "", model.AccountConfig{ID: "wechat", Channel: model.WeChat, AllowedSenders: []string{"alice"}, Config: json.RawMessage(`{}`)}, model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: json.RawMessage(`{}`)}, filepath.Join(t.TempDir(), "relay.db"))
	store, err := storage.Open(context.Background(), cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	cfg.Bindings[0].AllowedSenders = []string{}
	if _, err := core.New(cfg, store, core.Options{}); err == nil {
		t.Fatal("explicit empty narrowing allowlist silently inherited account scope")
	}
	cfg.Bindings[0].AllowedSenders = nil
	runtime, err := core.New(cfg, store, core.Options{})
	if err != nil || runtime.Config().Bindings[0].AllowedSenders != nil {
		t.Fatalf("nil inheritance did not survive construction: %v", err)
	}
	cfg.Bindings[0].AllowedSenders = []string{"alice"}
	runtime, err = core.New(cfg, store, core.Options{})
	if err != nil {
		t.Fatal(err)
	}
	copy := runtime.Config()
	copy.Bindings[0].AllowedSenders[0] = "changed"
	if runtime.Config().Bindings[0].AllowedSenders[0] != "alice" {
		t.Fatal("configuration snapshot mutated runtime authorization")
	}
	data, err := json.Marshal(model.Binding{AllowedSenders: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	var binding model.Binding
	if err := json.Unmarshal(data, &binding); err != nil || binding.AllowedSenders == nil {
		t.Fatal("explicit empty scope was lost across a configuration snapshot")
	}
}

// Native subscriptions/recovery need exact configured threads without seeing
// another account's addresses. A shared-host implementation can accidentally
// return every configured conversation or an alias of its internal snapshot;
// existing ingest authorization tests do not exercise this discovery boundary.
// Real storage and the public host API suffice; no production seam is added.
func TestChannelBoundAddressesPreserveThreadAndAccountScope(t *testing.T) {
	cfg := relayConfig(t, "", model.AccountConfig{ID: "wechat", Channel: model.WeChat, AllowedSenders: []string{"alice"}, Config: json.RawMessage(`{}`)}, model.EndpointConfig{ID: "grok", Agent: model.Grok, Config: json.RawMessage(`{}`)}, filepath.Join(t.TempDir(), "relay.db"))
	cfg.Accounts = append(cfg.Accounts, model.AccountConfig{ID: "other", Channel: model.WeChat, AllowedSenders: []string{"alice"}, Config: json.RawMessage(`{}`)})
	cfg.Bindings = append(cfg.Bindings, model.Binding{AccountID: "wechat", ChatID: "alice", ThreadID: "thread", EndpointID: "grok"}, model.Binding{AccountID: "other", ChatID: "private", ThreadID: "private-thread", EndpointID: "grok"})
	store, err := storage.Open(context.Background(), cfg.Storage, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	runtime, err := core.New(cfg, store, core.Options{})
	if err != nil {
		t.Fatal(err)
	}
	host, err := runtime.ChannelHost("wechat")
	if err != nil {
		t.Fatal(err)
	}
	addresses := host.BoundAddresses()
	if len(addresses) != 2 {
		t.Fatalf("exact account bindings missing: %+v", addresses)
	}
	threads := map[string]bool{}
	for _, address := range addresses {
		if address.AccountID != "wechat" || address.ChatID != "alice" || address.ID == "" {
			t.Fatalf("account scope escaped: %+v", address)
		}
		threads[address.ThreadID] = true
	}
	if !threads[""] || !threads["thread"] {
		t.Fatalf("configured thread was omitted: %+v", addresses)
	}
	addresses[0].ChatID = "mutated"
	if host.BoundAddresses()[0].ChatID == "mutated" {
		t.Fatal("bound address snapshot mutated runtime scope")
	}
}
