package discord

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
)

const discordEpochMS int64 = 1420070400000

func (c *Channel) boundAddress(nativeID string) (model.ChannelAddress, bool) {
	for _, address := range c.addresses {
		if address.AccountID != c.account.ID || address.Platform != model.Discord {
			continue
		}
		id := address.ChatID
		if address.ThreadID != "" {
			id = address.ThreadID
		}
		if id == nativeID {
			return address, true
		}
	}
	return model.ChannelAddress{}, false
}

func (c *Channel) initialState(ctx context.Context, bot *identity) (gatewayState, error) {
	state, entry, err := common.ReadState[gatewayState](ctx, c.host.State(), c.gatewayKey(bot))
	if err != nil {
		return state, err
	}
	explicitReset := c.config.RecoveryEpoch != "" && c.config.RecoveryEpoch != state.RecoveryEpoch
	if explicitReset {
		state = gatewayState{RecoveryEpoch: c.config.RecoveryEpoch}
	}
	initial := state.StartedAtMS == 0
	if initial {
		state.StartedAtMS = time.Now().UnixMilli()
		if state.Anchors == nil {
			state.Anchors = map[string]string{}
		}
	}
	c.reconcileHistoryScope(&state, initial)
	if entry != nil && !explicitReset && state.SessionID == "" {
		state.Recovering = true
	}
	if err = common.SaveState(ctx, c.host.State(), c.gatewayKey(bot), state, nil); err != nil {
		return state, err
	}
	return state, nil
}

func (c *Channel) reconcileHistoryScope(state *gatewayState, initial bool) {
	anchors := make(map[string]string, len(c.addresses))
	since := make(map[string]int64, len(c.addresses))
	for _, address := range c.addresses {
		if address.AccountID != c.account.ID || address.Platform != model.Discord {
			continue
		}
		id := address.ChatID
		if address.ThreadID != "" {
			id = address.ThreadID
		}
		anchors[id] = state.Anchors[id]
		since[id] = state.BoundSinceMS[id]
		if since[id] == 0 {
			since[id] = time.Now().UnixMilli()
			if initial {
				since[id] = state.StartedAtMS
			}
		}
	}
	state.Anchors = anchors
	state.BoundSinceMS = since
}

func (c *Channel) requireHistory(ctx context.Context, bot *identity) error {
	state, _, err := common.ReadState[gatewayState](ctx, c.host.State(), c.gatewayKey(bot))
	if err != nil {
		return err
	}
	state.SessionID = ""
	state.ResumeURL = ""
	state.Sequence = nil
	state.Recovering = true
	return common.SaveState(ctx, c.host.State(), c.gatewayKey(bot), state, nil)
}

func messageNumber(value string) uint64 {
	number, _ := strconv.ParseUint(value, 10, 64)
	return number
}

func (c *Channel) rememberMessage(id, channel string, state *gatewayState) error {
	if _, bound := c.boundAddress(channel); !bound {
		return nil
	}
	if !snowflake(id) {
		return errors.New("invalid_native_message")
	}
	if state.Anchors == nil {
		state.Anchors = map[string]string{}
	}
	if messageNumber(id) > messageNumber(state.Anchors[channel]) {
		state.Anchors[channel] = id
	}
	return nil
}

func (c *Channel) recoverHistory(ctx context.Context, bot *identity, state *gatewayState) error {
	if state.StartedAtMS < discordEpochMS || uint64(state.StartedAtMS-discordEpochMS) > ^uint64(0)>>22 {
		return errors.New("history_gap_unresolved")
	}
	for _, address := range c.addresses {
		if address.AccountID != c.account.ID || address.Platform != model.Discord {
			return errors.New("history_scope_mismatch")
		}
		native, err := c.nativeChannel(ctx, address.ChatID, address.ThreadID)
		if err != nil {
			return err
		}
		started := state.BoundSinceMS[native.ID]
		if started == 0 {
			started = state.StartedAtMS
		}
		if started < discordEpochMS || uint64(started-discordEpochMS) > ^uint64(0)>>22 {
			return errors.New("history_gap_unresolved")
		}
		floor := uint64(started-discordEpochMS) << 22
		messages, err := c.history(ctx, native, state.Anchors[native.ID], floor)
		if err != nil {
			return err
		}
		if err = c.acceptHistory(ctx, messages, bot, native, state); err != nil {
			return err
		}
	}
	state.Recovering = false
	return nil
}

func (c *Channel) acceptHistory(ctx context.Context, messages []discordgo.Message, bot *identity, native *discordgo.Channel, state *gatewayState) error {
	for _, message := range messages {
		if err := c.receiveMessage(ctx, message, bot, native); err != nil && !common.PolicyRejection(err) {
			return err
		}
		if state.Anchors == nil {
			state.Anchors = map[string]string{}
		}
		if messageNumber(message.ID) > messageNumber(state.Anchors[native.ID]) {
			state.Anchors[native.ID] = message.ID
		}
	}
	return nil
}

// Native messages are newest first. Recover only a bounded gap and validate a
// whole page before it can enter Core. Missing existing anchors are explicit
// gaps, even if the server returns an empty page after deleting the old anchor.
// https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx#get-channel-messages
func (c *Channel) history(ctx context.Context, native *discordgo.Channel, anchor string, floor uint64) ([]discordgo.Message, error) {
	var collected []discordgo.Message
	before := ""
	for page := 0; page < 20; page++ {
		query := url.Values{"limit": []string{"100"}}
		if before != "" {
			query.Set("before", before)
		}
		var messages []discordgo.Message
		if err := c.api(ctx, http.MethodGet, "/channels/"+native.ID+"/messages?"+query.Encode(), nil, &messages); err != nil {
			return nil, err
		}
		if err := validateHistoryPage(messages, native, before); err != nil {
			return nil, err
		}
		complete, index, err := historyBoundary(messages, anchor, floor)
		if err != nil {
			return nil, err
		}
		collected = append(collected, messages[:index]...)
		if complete {
			slices.Reverse(collected)
			return collected, nil
		}
		if len(messages) == 0 {
			return nil, errors.New("history_gap_unresolved")
		}
		before = messages[len(messages)-1].ID
	}
	return nil, errors.New("history_gap_unresolved")
}

func validateHistoryPage(messages []discordgo.Message, native *discordgo.Channel, before string) error {
	if messages == nil || len(messages) > 100 {
		return errors.New("history_gap_unresolved")
	}
	previous := messageNumber(before)
	for _, message := range messages {
		if !snowflake(message.ID) || message.ChannelID != native.ID || message.Timestamp.IsZero() || message.GuildID != "" && message.GuildID != native.GuildID {
			return errors.New("invalid_native_history")
		}
		current := messageNumber(message.ID)
		if previous != 0 && current >= previous {
			return errors.New("invalid_native_history_order")
		}
		previous = current
	}
	return nil
}

func historyBoundary(messages []discordgo.Message, anchor string, floor uint64) (bool, int, error) {
	for index, message := range messages {
		if anchor != "" {
			if message.ID == anchor {
				return true, index, nil
			}
			if messageNumber(message.ID) < messageNumber(anchor) {
				return false, 0, errors.New("history_gap_unresolved")
			}
		} else if messageNumber(message.ID) < floor {
			return true, index, nil
		}
	}
	if len(messages) == 0 || len(messages) < 100 && anchor == "" {
		if anchor != "" {
			return false, 0, errors.New("history_gap_unresolved")
		}
		return true, len(messages), nil
	}
	return false, len(messages), nil
}
