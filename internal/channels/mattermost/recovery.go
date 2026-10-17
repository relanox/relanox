package mattermost

import (
	"context"
	"errors"
	"sort"

	mm "github.com/mattermost/mattermost/server/public/model"
	"github.com/relanox/relanox/internal/channels/common"
)

var errHistoryIncomplete = errors.New("history_recovery_incomplete")
var errHistoryUnavailable = errors.New("history_recovery_unavailable")

const historyLimit = 1000
const historyChannelsPerSession = 10

type historyRecovery struct {
	Channels []historyChannel `json:"channels"`
}

type historyChannel struct {
	ChannelID   string `json:"channelId"`
	SinceMS     int64  `json:"sinceMs"`
	HighWaterMS int64  `json:"highWaterMs"`
	Done        bool   `json:"done"`
}

// Since returns all modified posts below its 1000-row cap, without promising a
// contiguous order. Before/after use a strict create_at comparison and can omit
// same-millisecond siblings. Refuse a capped/inaccessible set; validate the whole
// visible set, then ingest create_at/id ascending with a 1ms durable overlap.
// https://docs.mattermost.com/api/reference/get-posts-for-channel
// https://github.com/mattermost/mattermost/blob/master/server/channels/store/sqlstore/post_store.go
func (c *Channel) recoverHistory(ctx context.Context, saved *cursor) error {
	if saved.Recovery == nil {
		saved.Recovery = c.recoveryPlan(saved)
		if err := common.SaveState(ctx, c.host.State(), "websocket-cursor", saved, nil); err != nil {
			return err
		}
	}
	_, token, err := c.credentials(ctx)
	if err != nil {
		return errHistoryUnavailable
	}
	budget := historyChannelsPerSession
	for i := range saved.Recovery.Channels {
		channel := &saved.Recovery.Channels[i]
		if !common.Contains(c.host.BoundChatIDs(), channel.ChannelID) {
			channel.Done = true
		}
		if channel.Done {
			continue
		}
		if budget == 0 {
			return errHistoryIncomplete
		}
		budget--
		if err = c.recoverChannel(ctx, saved, channel, token); err != nil {
			return err
		}
		if err = common.SaveState(ctx, c.host.State(), "websocket-cursor", saved, nil); err != nil {
			return err
		}
	}
	if saved.Watermarks == nil {
		saved.Watermarks = map[string]int64{}
	}
	for _, channel := range saved.Recovery.Channels {
		if common.Contains(c.host.BoundChatIDs(), channel.ChannelID) {
			saved.Watermarks[channel.ChannelID] = max(saved.Watermarks[channel.ChannelID], channel.HighWaterMS)
		}
	}
	saved.Recovery = nil
	return nil
}

func (c *Channel) recoveryPlan(saved *cursor) *historyRecovery {
	result := &historyRecovery{}
	channels := append([]string(nil), c.host.BoundChatIDs()...)
	sort.Strings(channels)
	seen := map[string]bool{}
	for _, id := range channels {
		if !mm.IsValidId(id) || seen[id] {
			continue
		}
		seen[id] = true
		since := max(saved.Watermarks[id], saved.BoundStarts[id])
		if since == 0 {
			since = saved.StartedAtMS
		}
		result.Channels = append(result.Channels, historyChannel{ChannelID: id, SinceMS: max(0, since-1), HighWaterMS: since})
	}
	return result
}

func (c *Channel) recoverChannel(ctx context.Context, saved *cursor, channel *historyChannel, token string) error {
	list, response, err := c.nativeClient(ctx, token, common.MaxJSONBytes).GetPostsSince(ctx, channel.ChannelID, channel.SinceMS, false)
	if nativeError(response, err) != nil || list == nil {
		return errHistoryUnavailable
	}
	posts, err := validateHistory(list, channel.ChannelID)
	if err != nil {
		return err
	}
	for _, post := range posts {
		if post.CreateAt < channel.SinceMS {
			continue
		}
		if post.DeleteAt == 0 {
			if err := c.receive(ctx, post, saved.Identity); err != nil {
				return errHistoryUnavailable
			}
		}
		channel.HighWaterMS = max(channel.HighWaterMS, post.CreateAt)
	}
	channel.Done = true
	return nil
}

func validateHistory(list *mm.PostList, channelID string) ([]*mm.Post, error) {
	if len(list.Order) >= historyLimit || list.FirstInaccessiblePostTime > 0 || (list.HasNext != nil && *list.HasNext) {
		return nil, errHistoryIncomplete
	}
	posts := make([]*mm.Post, 0, len(list.Order))
	seen := map[string]bool{}
	for _, id := range list.Order {
		post := list.Posts[id]
		if post == nil || post.Id != id || post.ChannelId != channelID || !validPost(post) || seen[id] {
			return nil, errHistoryUnavailable
		}
		seen[id] = true
		posts = append(posts, post)
	}
	sort.Slice(posts, func(i, j int) bool {
		if posts[i].CreateAt == posts[j].CreateAt {
			return posts[i].Id < posts[j].Id
		}
		return posts[i].CreateAt < posts[j].CreateAt
	})
	return posts, nil
}
