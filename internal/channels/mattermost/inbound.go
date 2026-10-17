package mattermost

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	mm "github.com/mattermost/mattermost/server/public/model"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

func validPost(post *mm.Post) bool {
	return mm.IsValidId(post.Id) && mm.IsValidId(post.ChannelId) && mm.IsValidId(post.UserId) && (post.RootId == "" || mm.IsValidId(post.RootId)) && post.CreateAt > 0
}

func (c *Channel) receive(ctx context.Context, post *mm.Post, identity targetData) error {
	if !validPost(post) {
		return errors.New("invalid_native_post")
	}
	if post.UserId == identity.BotUserID || !slices.Contains(c.account.AllowedSenders, post.UserId) || (post.Type != "" && post.Type != "me") {
		return nil
	}
	if err := c.host.DiscoverConversation(ctx, model.DiscoveredConversation{ChatID: post.ChannelId, ThreadID: post.RootId, SenderID: post.UserId}); err != nil {
		return err
	}
	if !slices.Contains(c.host.BoundChatIDs(), post.ChannelId) || (post.Message == "" && len(post.FileIds) == 0) {
		return nil
	}
	attachments, err := c.receiveFiles(ctx, post)
	if err != nil {
		if common.PolicyRejection(err) {
			return nil
		}
		return err
	}
	return common.Ingest(ctx, c.host, model.IngestInput{Source: model.SourceKey{Channel: model.Mattermost, AccountID: c.account.ID, EventID: post.Id}, SenderID: post.UserId, Text: post.Message, Attachments: attachments, Target: model.ReplyTarget{Channel: model.Mattermost, AccountID: c.account.ID, ChatID: post.ChannelId, ThreadID: post.RootId, ReplyToID: post.Id, Data: common.Data(identity)}, ReceivedAt: time.UnixMilli(post.CreateAt)})
}

func (c *Channel) receiveFiles(ctx context.Context, post *mm.Post) ([]model.MediaUpload, error) {
	if len(post.FileIds) > 10 {
		return nil, errors.New("too_many_attachments")
	}
	if len(post.FileIds) == 0 {
		return nil, nil
	}
	_, token, err := c.credentials(ctx)
	if err != nil {
		return nil, err
	}
	infos, response, err := c.nativeClient(ctx, token, common.MaxJSONBytes).GetFileInfosForPost(ctx, post.Id, "")
	if err := nativeError(response, err); err != nil {
		return nil, err
	}
	attachments := make([]model.MediaUpload, 0, len(post.FileIds))
	for _, id := range post.FileIds {
		media, err := c.receiveFile(ctx, post.Id, id, token, infos)
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, media)
	}
	return attachments, nil
}

func (c *Channel) receiveFile(ctx context.Context, postID, id, token string, infos []*mm.FileInfo) (model.MediaUpload, error) {
	var output model.MediaUpload
	if !mm.IsValidId(id) {
		return output, errors.New("invalid_native_file")
	}
	var info *mm.FileInfo
	for _, item := range infos {
		if item != nil && item.Id == id {
			info = item
			break
		}
	}
	if info == nil || (info.PostId != "" && info.PostId != postID) || info.Size < 0 {
		return output, errors.New("invalid_media_metadata")
	}
	if info.Size > common.MediaLimit(c.host) {
		return output, errors.New("media_too_large")
	}
	raw, response, err := c.nativeClient(ctx, token, common.MediaLimit(c.host)).GetFile(ctx, id)
	if err := nativeError(response, err); err != nil {
		return output, err
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(info.MimeType, ";")[0]))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return model.MediaUpload{Data: raw, FileName: info.Name, MIMEType: mimeType, Kind: common.MediaKind(mimeType)}, nil
}
