package feishu

import (
	"context"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// Public Resolve must reject old native ownership rather than constructing a
// target for the current bot. The real token/bot-info HTTP peer supplies current
// identity; existing Send tests bypass resolution and miss this regression.
func TestResolveRejectsChangedLearnedNativeIdentity(t *testing.T) {
	c, p := mediaFixture(t)
	address := model.ChannelAddress{Platform: model.Feishu, AccountID: "account", ChatID: "oc_chat"}
	for _, fixture := range []struct{ app, bot, tenant, chat string }{{"old-app", "ou_bot", "tenant", "oc_chat"}, {"app", "old-bot", "tenant", "oc_chat"}, {"app", "ou_bot", "old-tenant", "oc_chat"}, {"app", "ou_bot", "tenant", "oc_other"}} {
		data := targetData{AppID: fixture.app, BotID: fixture.bot, TenantKey: fixture.tenant, APIBaseURL: "https://open.feishu.cn"}
		learned := &model.ReplyTarget{Channel: model.Feishu, AccountID: "account", ChatID: fixture.chat, Data: common.Data(data)}
		result, err := c.Resolve(context.Background(), address, learned)
		if err != nil || result.Available || result.Reason != "target_identity_changed" {
			t.Fatalf("replacement identity: %+v %v", result, err)
		}
	}
	result, err := c.Resolve(context.Background(), address, nil)
	if err != nil || !result.Available || p.tokens != 1 {
		t.Fatalf("configured proactive identity: %+v %v", result, err)
	}
}
