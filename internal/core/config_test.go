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
