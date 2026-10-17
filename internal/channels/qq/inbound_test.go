package qq

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

// A single native message can contain separately indexed parts. Collapsing them
// onto msg_id loses accepted input; using a quoted index changes the reply target.
// The gateway state tests have no message payloads. Native fixture transformation
// is exercised directly, without fake core acceptance or a production-only seam.
func TestNativePartIdentityPreservesIndexAndSequence(t *testing.T) {
	// Official SDK 1.0.5 protocol/gateway/event-dispatcher.ts parseRefIndices;
	// native msg_seq is forwarded by the raw event without SDK normalization.
	// https://github.com/tencent-connect/qqbot-nodejs
	for _, fixture := range []struct{ raw, want string }{
		{`{"id":"shared","message_type":103,"message_scene":{"ext":["msg_idx=part-one","ref_msg_idx=quoted"]},"msg_elements":[{"msg_idx":"quoted"}]}`, `["C2C_MESSAGE_CREATE","shared","part-one"]`},
		{`{"id":"shared","msg_seq":0}`, `["C2C_MESSAGE_CREATE","shared",0]`},
		{`{"id":"shared","msg_seq":65535}`, `["C2C_MESSAGE_CREATE","shared",65535]`},
		{`{"id":"shared"}`, `["C2C_MESSAGE_CREATE","shared",null]`},
	} {
		var message nativeMessage
		if err := json.Unmarshal([]byte(fixture.raw), &message); err != nil {
			t.Fatal(err)
		}
		if actual := eventID("C2C_MESSAGE_CREATE", message, ownMessageIndex(message)); actual != fixture.want {
			t.Fatalf("native part identity: %s; want %s", actual, fixture.want)
		}
	}
}

func TestUnavailableNativeAttachmentsRetainFallbacksAndCancellation(t *testing.T) {
	c, _ := New(testHost{}, model.AccountConfig{ID: "account", Channel: model.QQ, Config: common.Data(Config{AppID: "app", ClientSecret: model.SecretRef{Env: "SECRET"}})}, common.Options{})
	defer func() { _ = c.Close(context.Background()) }()
	attachments := []nativeAttachment{{URL: "https://127.0.0.1/image.png", ContentType: "image/png", FileName: "image.png"}, {ContentType: "voice", FileName: "voice.amr", Recognition: "native transcript"}, {ContentType: "file", FileName: "report.pdf"}}
	result, err := c.downloadAttachments(context.Background(), attachments)
	if err != nil || len(result.uploads) != 0 || len(result.images) != 1 {
		t.Fatalf("fallbacks: %+v %v", result, err)
	}
	if fmt.Sprint(result.fallbacks) != "[[Image: https://127.0.0.1/image.png] native transcript [Attachment: report.pdf]]" {
		t.Fatalf("native attachment data lost: %v", result.fallbacks)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = c.downloadAttachments(ctx, attachments); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation was converted into fallback content")
	}
}

func TestResolveRejectsChangedLearnedIdentity(t *testing.T) {
	c, _ := testChannel(t, nil)
	address := model.ChannelAddress{Platform: model.QQ, AccountID: "account", ChatID: "group"}
	resolved, err := c.Resolve(context.Background(), address, nil)
	if err != nil || !resolved.Available {
		t.Fatalf("configured proactive resolve: %+v %v", resolved, err)
	}
	for _, fixture := range []struct{ app, kind, chat string }{{"replaced-app", "group", "group"}, {"app", "c2c", "group"}, {"app", "group", "other"}} {
		learned := &model.ReplyTarget{Channel: model.QQ, AccountID: "account", ChatID: fixture.chat, Data: common.Data(targetData{Type: fixture.kind, Scope: identity{AppID: fixture.app, APIBase: c.base() + "/"}})}
		resolved, err = c.Resolve(context.Background(), address, learned)
		if err != nil || resolved.Available || resolved.Reason != "target_identity_changed" {
			t.Fatalf("old target reused: %+v %v", resolved, err)
		}
	}
}
