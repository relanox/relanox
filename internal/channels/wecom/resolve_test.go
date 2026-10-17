package wecom

import (
	"context"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// Configured socket recipients must not replace learned bot, transport or chat
// kind. A reused account ID otherwise lets an old accepted request use a new
// native destination. Socket upload tests do not call public Resolve.
func TestConfiguredSocketRecipientKeepsLearnedIdentity(t *testing.T) {
	c, err := New(nil, model.AccountConfig{ID: "account", Channel: model.WeCom, Config: common.Data(Config{BotID: "bot", Secret: model.SecretRef{Env: "SECRET"}, RecipientTypes: map[string]string{"chat": "single"}})}, common.Options{})
	if err != nil {
		t.Fatal(err)
	}
	address := model.ChannelAddress{Platform: model.WeCom, AccountID: "account", ChatID: "chat"}
	for _, fixture := range []struct{ bot, url, mode, kind string }{{"old-bot", websocketURL, "", "single"}, {"bot", "wss://old.example", "", "single"}, {"bot", websocketURL, "webhook", "single"}, {"bot", websocketURL, "", "group"}} {
		data := targetData{ChatType: fixture.kind}
		data.Scope.BotID = fixture.bot
		data.Scope.WebsocketURL = fixture.url
		data.Scope.Mode = fixture.mode
		learned := &model.ReplyTarget{Channel: model.WeCom, AccountID: "account", ChatID: "chat", Data: common.Data(data)}
		result, err := c.Resolve(context.Background(), address, learned)
		if err != nil || result.Available || result.Reason != "target_identity_changed" {
			t.Fatalf("socket target replaced learned scope: %+v %v", result, err)
		}
	}
	result, err := c.Resolve(context.Background(), address, nil)
	if err != nil || !result.Available {
		t.Fatalf("configured socket recipient: %+v %v", result, err)
	}
}
