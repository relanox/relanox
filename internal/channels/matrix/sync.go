package matrix

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/relanox/relanox/internal/channels/common"
	"github.com/relanox/relanox/internal/model"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

type roomCheckpoint struct {
	LastEventID string `json:"lastEventId,omitempty"`
	Encrypted   bool   `json:"encrypted,omitempty"`
}

type checkpoint struct {
	Since string                    `json:"since"`
	Rooms map[string]roomCheckpoint `json:"rooms"`
}

func (c *Channel) checkpointKey(client *mautrix.Client) string {
	return "sync:" + string(common.Data([]string{c.config.Homeserver, string(client.UserID)}))
}

func (c *Channel) loop(ctx context.Context) {
	for ctx.Err() == nil {
		client, err := c.client(ctx)
		if err == nil {
			err = c.poll(ctx, client)
		}
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			code := "native_sync_failed"
			if err.Error() == "sync_gap_unresolved" {
				code = "sync_gap_unresolved"
			}
			c.host.Connection(model.Degraded, code)
			if common.Delay(ctx, time.Second) != nil {
				break
			}
		} else {
			c.host.Connection(model.Connected, "")
			if common.Delay(ctx, 25*time.Millisecond) != nil {
				break
			}
		}
	}
	c.host.Connection(model.Disconnected, "")
}

func (c *Channel) filter() mautrix.Filter {
	rooms := make([]id.RoomID, len(c.rooms))
	for i, room := range c.rooms {
		rooms[i] = id.RoomID(room)
	}
	return mautrix.Filter{EventFormat: mautrix.EventFormatClient, Room: &mautrix.RoomFilter{Rooms: rooms, Timeline: &mautrix.FilterPart{Limit: 100, Types: []event.Type{event.EventMessage, event.EventEncrypted}}, State: &mautrix.FilterPart{Types: []event.Type{event.StateEncryption}}}}
}

func (c *Channel) poll(ctx context.Context, client *mautrix.Client) error {
	state, entry, err := common.ReadState[checkpoint](ctx, c.host.State(), c.checkpointKey(client))
	if err != nil {
		return err
	}
	response, err := client.FullSyncRequest(quiet(ctx), mautrix.ReqSync{Timeout: 30000, Since: state.Since, FilterID: string(common.Data(c.filter()))})
	if err != nil {
		return err
	}
	if response == nil || !platformID(response.NextBatch) {
		return errors.New("invalid_sync_cursor")
	}
	next := checkpoint{Since: response.NextBatch, Rooms: make(map[string]roomCheckpoint, len(c.rooms))}
	for _, roomID := range c.rooms {
		prior := state.Rooms[roomID]
		room := response.Rooms.Join[id.RoomID(roomID)]
		if room == nil {
			next.Rooms[roomID] = prior
			continue
		}
		updated, err := c.room(ctx, client, roomID, prior, room)
		if err != nil {
			return err
		}
		next.Rooms[roomID] = updated
	}
	var expected *int64
	if entry != nil {
		expected = &entry.Version
	}
	result, err := c.host.State().CompareAndSet(ctx, model.CompareAndSetStateInput{Key: c.checkpointKey(client), ExpectedVersion: expected, Value: common.Data(next)})
	if err != nil {
		return err
	}
	if result.Status != model.Updated {
		return errors.New("sync_checkpoint_conflict")
	}
	return nil
}

func (c *Channel) room(ctx context.Context, client *mautrix.Client, roomID string, prior roomCheckpoint, room *mautrix.SyncJoinedRoom) (roomCheckpoint, error) {
	next := prior
	for _, state := range room.State.Events {
		if state != nil && state.Type == event.StateEncryption {
			next.Encrypted = true
		}
	}
	if room.StateAfter != nil {
		for _, state := range room.StateAfter.Events {
			if state != nil && state.Type == event.StateEncryption {
				next.Encrypted = true
			}
		}
	}
	var earlier []*event.Event
	if room.Timeline.Limited && prior.LastEventID != "" && !containsEvent(room.Timeline.Events, prior.LastEventID) {
		var err error
		earlier, err = c.backfill(ctx, client, roomID, room.Timeline.PrevBatch, prior.LastEventID)
		if err != nil {
			return prior, err
		}
	}
	for _, message := range append(earlier, room.Timeline.Events...) {
		if message == nil || !platformID(string(message.ID)) {
			return prior, errors.New("invalid_native_event")
		}
		if !next.Encrypted {
			if err := c.receive(ctx, client, roomID, message); err != nil && !common.PolicyRejection(err) {
				return prior, err
			}
		}
		next.LastEventID = string(message.ID)
	}
	return next, nil
}

func containsEvent(events []*event.Event, eventID string) bool {
	for _, event := range events {
		if event != nil && string(event.ID) == eventID {
			return true
		}
	}
	return false
}

// Recover limited timelines oldest first. Both HTTP pages and retained events
// are bounded; an unavailable anchor leaves the original global cursor intact.
func (c *Channel) backfill(ctx context.Context, client *mautrix.Client, roomID, from, anchor string) ([]*event.Event, error) {
	if from == "" {
		return nil, errors.New("sync_gap_unresolved")
	}
	var reversed []*event.Event
	for page := 0; page < 20; page++ {
		response, err := client.Messages(quiet(ctx), id.RoomID(roomID), from, "", mautrix.DirectionBackward, &mautrix.FilterPart{Types: []event.Type{event.EventMessage, event.EventEncrypted}}, 100)
		if err != nil {
			return nil, err
		}
		if response == nil || len(response.Chunk) > 100 {
			return nil, errors.New("sync_gap_unresolved")
		}
		for _, message := range response.Chunk {
			if message == nil {
				return nil, errors.New("invalid_native_event")
			}
			if string(message.ID) == anchor {
				slices.Reverse(reversed)
				return reversed, nil
			}
			reversed = append(reversed, message)
		}
		if len(response.Chunk) == 0 || response.End == "" || response.End == from {
			return nil, errors.New("sync_gap_unresolved")
		}
		from = response.End
	}
	return nil, errors.New("sync_gap_unresolved")
}
