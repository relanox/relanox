package dingtalk

import (
	"context"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// An explicit configured recipient cannot override a learned bot/recipient kind.
// Otherwise accepted replies can target a replacement app or a different native
// conversation type. Outbound HTTP tests never exercise public Resolve.
func TestConfiguredRecipientDoesNotReplaceLearnedIdentity(t *testing.T) {
	c, _ := nativeFixture(t)
	address := model.ChannelAddress{Platform: model.DingTalk, AccountID: "account", ChatID: "staff"}
	for _, fixture := range []struct{ client, robot, upload, kind string }{{"old-app", "robot", uploadBase, "single"}, {"app", "old-robot", uploadBase, "single"}, {"app", "robot", "https://old-upload.example", "single"}, {"app", "robot", uploadBase, "group"}} {
		data := targetData{Type: fixture.kind, StaffID: "staff", OpenConversationID: "staff", Scope: scope{ClientID: fixture.client, RobotCode: fixture.robot, APIBase: apiBase, UploadBase: fixture.upload}}
		learned := &model.ReplyTarget{Channel: model.DingTalk, AccountID: "account", ChatID: "staff", Data: common.Data(data)}
		result, err := c.Resolve(context.Background(), address, learned)
		if err != nil || result.Available || result.Reason != "target_identity_changed" {
			t.Fatalf("configured recipient replaced learned scope: %+v %v", result, err)
		}
	}
	result, err := c.Resolve(context.Background(), address, nil)
	if err != nil || !result.Available {
		t.Fatalf("configured proactive resolve: %+v %v", result, err)
	}
}
