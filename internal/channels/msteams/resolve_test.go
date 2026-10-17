package msteams

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

// A saved current installation must not replace the native ownership of an
// explicitly supplied learned target. Otherwise old accepted work can reply as a
// replacement bot. File-consent recovery tests never call public Resolve; this
// fixture uses real SQLite installation state and no test-only production seam.
func TestResolveDoesNotReplaceLearnedIdentityWithSavedInstallation(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, config.Storage{Driver: "sqlite", Path: filepath.Join(t.TempDir(), "state.db")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	host := &consentHost{state: store.State(model.StateNamespace{Component: "channel", OwnerID: "account"})}
	c, err := New(host, model.AccountConfig{ID: "account", Channel: model.MSTeams, Config: common.Data(Config{AppID: "app", TenantID: "tenant", BotID: "current-bot", AppSecret: model.SecretRef{Env: "SECRET"}, TrustedServiceOrigins: []string{"https://smba.trafficmanager.net"}})}, common.Options{})
	if err != nil {
		t.Fatal(err)
	}
	current := targetData{AppID: "app", TenantID: "tenant", BotID: "current-bot", UserID: "user", ConversationID: "chat", ServiceURL: "https://smba.trafficmanager.net/amer/"}
	if err = common.SaveState(ctx, host.State(), c.conversationKey("chat"), current, nil); err != nil {
		t.Fatal(err)
	}
	address := model.ChannelAddress{Platform: model.MSTeams, AccountID: "account", ChatID: "chat"}
	resolved, err := c.Resolve(ctx, address, nil)
	if err != nil || !resolved.Available {
		t.Fatalf("saved installation: %+v %v", resolved, err)
	}
	for _, fixture := range []struct{ app, bot, chat string }{{"previous-app", "current-bot", "chat"}, {"app", "previous-bot", "chat"}, {"app", "current-bot", "foreign-chat"}} {
		data := current
		data.AppID = fixture.app
		data.BotID = fixture.bot
		learned := &model.ReplyTarget{Channel: model.MSTeams, AccountID: "account", ChatID: fixture.chat, Data: common.Data(data)}
		resolved, err = c.Resolve(ctx, address, learned)
		if err != nil || resolved.Available || resolved.Reason != "target_identity_changed" {
			t.Fatalf("saved state replaced old identity: %+v %v", resolved, err)
		}
	}
}
