package storage_test

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/storage"
)

func asset(id string, kind model.MediaKind, data string) model.StoredMedia {
	sum := sha256.Sum256([]byte(data))
	return model.StoredMedia{Reference: model.MediaReference{ID: id, Kind: kind, MIMEType: "application/octet-stream", FileName: id, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}, Data: []byte(data)}
}

// Media tests protect immutable ownership, transactional staged quotas and
// preview graphs. A separate count/insert or metadata-only ownership check would
// oversubscribe quotas or leak cross-channel bytes. No production seam is used.
func TestMediaOwnershipPreviewAndTransactionalBudget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "media.db")
	stores := []*storage.Store{openStore(t, path), openStore(t, path)}
	s := stores[0]
	initialize(t, s)
	limits := model.MediaLimits{MaxBytes: 10, MaxTotalBytes: 10, MaxAttachments: 2}
	preview := asset("preview", model.Image, "abc")
	put := func(s *storage.Store, media model.StoredMedia) model.PutMediaResult {
		t.Helper()
		r, err := s.PutMedia(ctx, model.PutMediaInput{ChannelID: "c1", Agent: model.Dot, EndpointIDs: []string{"agent"}, Media: media, Limits: limits})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	if r := put(s, preview); r.Status != model.Stored {
		t.Fatalf("preview: %#v", r)
	}
	bad := asset("bad", model.Video, "xyz")
	bad.Reference.PreviewMediaID = "missing"
	if r := put(s, bad); r.Status != model.InvalidMediaPreview {
		t.Fatalf("invalid preview accepted: %#v", r)
	}
	video := asset("video", model.Video, "1234")
	video.Reference.PreviewMediaID = "preview"
	other := asset("other", model.File, "5678")
	var wait sync.WaitGroup
	results := make(chan model.PutMediaResult, 2)
	for i, media := range []model.StoredMedia{video, other} {
		wait.Go(func() {
			r, err := stores[i].PutMedia(ctx, model.PutMediaInput{ChannelID: "c1", Agent: model.Dot, EndpointIDs: []string{"agent"}, Media: media, Limits: limits})
			if err != nil {
				t.Error(err)
			}
			results <- r
		})
	}
	wait.Wait()
	close(results)
	stored, limited := 0, 0
	for r := range results {
		if r.Status == model.Stored {
			stored++
		}
		if r.Status == model.TooManyAttachments {
			limited++
		}
	}
	if stored != 1 || limited != 1 {
		t.Fatalf("budget race: stored=%d limited=%d", stored, limited)
	}
	changed := asset("preview", model.Image, "modified")
	if r := put(s, changed); r.Status != model.Conflict {
		t.Fatalf("immutable asset overwritten: %#v", r)
	}
	foreign := conversationRecord()
	foreign.Address.ID = "c2"
	foreign.Address.ChatID = "other-chat"
	if err := s.RegisterConversations(ctx, []model.ConversationRecord{conversationRecord(), foreign}); err != nil {
		t.Fatal(err)
	}
	r, err := s.PutMedia(ctx, model.PutMediaInput{ChannelID: "c2", Agent: model.Dot, EndpointIDs: []string{"agent"}, Media: preview, Limits: limits})
	if err != nil || r.Status != model.Conflict {
		t.Fatalf("cross-channel media reuse: %#v %v", r, err)
	}
	if media, err := s.GetMedia(ctx, "c2", "preview"); err != nil || media != nil {
		t.Fatalf("cross-channel read: %#v %v", media, err)
	}
}

func TestMediaSurvivesPendingDeliveryThenRedactsWithoutLosingReplay(t *testing.T) {
	s := openStore(t, filepath.Join(t.TempDir(), "retention.db"))
	initialize(t, s)
	at := time.Now().Add(-time.Hour).UTC()
	image := asset("image", model.Image, "image-bytes")
	input := outboundInput("key", "delivery", at, nil)
	input.Media = []model.StoredMedia{image}
	input.Message.Attachments = []model.MediaReference{image.Reference}
	input.Outbound.Chunks = []model.DeliveryChunk{{Media: &image.Reference, IdempotencyKey: "delivery/0"}}
	r, err := s.EnqueueMessage(ctx, input)
	if err != nil || r.Status != model.Queued {
		t.Fatalf("media enqueue: %#v %v", r, err)
	}
	if _, err := s.Cleanup(ctx, model.CleanupInput{Before: at.Add(time.Minute), Limit: 1}); err != nil {
		t.Fatal(err)
	}
	if media, err := s.GetMedia(ctx, "c1", "image"); err != nil || media == nil || string(media.Data) != "image-bytes" {
		t.Fatalf("pending media redacted: %#v %v", media, err)
	}
	work := take(t, s, at, model.SendWork)
	if len(work) != 1 || settle(t, s, work[0], at, model.Sent).Status != model.Updated {
		t.Fatal("send settlement failed")
	}
	if _, err := s.Cleanup(ctx, model.CleanupInput{Before: at.Add(time.Minute), Limit: 1}); err != nil {
		t.Fatal(err)
	}
	if media, err := s.GetMedia(ctx, "c1", "image"); err != nil || media != nil {
		t.Fatalf("sent bytes retained: %#v %v", media, err)
	}
	if ref, err := s.GetReference(ctx, "c1", "image"); err != nil || ref == nil || ref.SHA256 != image.Reference.SHA256 {
		t.Fatalf("immutable metadata lost: %#v %v", ref, err)
	}
	input.Message.CreatedAt = time.Now()
	r, err = s.GetMessageReceipt(ctx, model.MessageReceiptInput{ChannelID: "c1", Agent: model.Dot, EndpointIDs: []string{"agent"}, Message: input.Message})
	if err != nil || r.Status != model.Queued || !r.Replay {
		t.Fatalf("redacted media send replay: %#v %v", r, err)
	}
}
