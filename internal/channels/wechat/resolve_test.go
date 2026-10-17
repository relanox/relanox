package wechat

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

type resolveHost struct {
	model.ChannelHost
	state model.StateStore
}

func (h resolveHost) State() model.StateStore { return h.state }

// Public Resolve must retain accepted native bot ownership even when a newer
// current context exists. Replacing a bot under one account ID otherwise routes
// an old final reply through its replacement. Existing send tests do not resolve
// learned targets; actual SQLite state is used without a new production seam.
func TestResolveChecksLearnedIdentityBeforeRefreshingContext(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, config.Storage{Driver: "sqlite", Path: filepath.Join(t.TempDir(), "state.db")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	host := resolveHost{state: store.State(model.StateNamespace{Component: "channel", OwnerID: "account"})}
	c, err := New(host, model.AccountConfig{ID: "account", Channel: model.WeChat, Config: common.Data(Config{BotID: "current-bot", BotToken: model.SecretRef{Env: "TOKEN"}})}, common.Options{})
	if err != nil {
		t.Fatal(err)
	}
	fresh := targetData{BotID: c.config.BotID, APIBaseURL: c.config.APIBaseURL, ContextToken: "fresh-context"}
	if err = common.SaveState(ctx, host.State(), c.key("context:chat"), fresh, nil); err != nil {
		t.Fatal(err)
	}
	address := model.ChannelAddress{Platform: model.WeChat, AccountID: "account", ChatID: "chat"}
	for _, fixture := range []struct{ bot, base, chat string }{{"previous-bot", c.config.APIBaseURL, "chat"}, {c.config.BotID, "https://regional.wechat.example", "chat"}, {c.config.BotID, c.config.APIBaseURL, "foreign-chat"}} {
		learned := &model.ReplyTarget{Channel: model.WeChat, AccountID: "account", ChatID: fixture.chat, Data: common.Data(targetData{BotID: fixture.bot, APIBaseURL: fixture.base, ContextToken: "old-context"})}
		result, err := c.Resolve(ctx, address, learned)
		if err != nil || result.Available || result.Reason != "target_identity_changed" {
			t.Fatalf("old native identity refreshed: %+v %v", result, err)
		}
	}
	prior := fresh
	prior.ContextToken = "old-context"
	learned := &model.ReplyTarget{Channel: model.WeChat, AccountID: "account", ChatID: "chat", ReplyToID: "selected-message", Data: common.Data(prior)}
	result, err := c.Resolve(ctx, address, learned)
	if err != nil || !result.Available || result.Target == nil {
		t.Fatalf("same identity: %+v %v", result, err)
	}
	var actual targetData
	if json.Unmarshal(result.Target.Data, &actual) != nil || actual.ContextToken != "fresh-context" || result.Target.ReplyToID != "selected-message" {
		t.Fatal("same-bot context refresh or selected message lost")
	}
}
