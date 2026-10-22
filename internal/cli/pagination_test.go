package cli

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

// Status pages must traverse every stored request once using the advertised ID
// cursor. Single-record CLI fixtures missed the switch from newest-first on the
// initial page to ascending IDs on later pages. Real SQLite records deliberately
// use different acceptance and ID orders; no storage or command seam is added.
func TestStatusPaginationKeepsOneOrderAcrossPages(t *testing.T) {
	path, _ := adminFixture(t)
	addStatusPageRequests(t, path)
	var got []string
	var after string
	for range 3 {
		args := []string{"--config", path, "status", "--limit", "2"}
		if after != "" {
			args = append(args, "--after-id", after)
		}
		out, err := execute(t, "", args...)
		if err != nil {
			t.Fatal(err)
		}
		var page struct {
			Requests []struct{ RequestID string }
		}
		if err = json.Unmarshal([]byte(out), &page); err != nil {
			t.Fatal(err)
		}
		if len(page.Requests) == 0 {
			break
		}
		for _, request := range page.Requests {
			got = append(got, request.RequestID)
		}
		after = page.Requests[len(page.Requests)-1].RequestID
	}
	if want := []string{"request-a", "request-m", "request-private", "request-z"}; !slices.Equal(got, want) {
		t.Fatalf("paginated requests = %v, want %v without omissions or duplicates", got, want)
	}
}

func addStatusPageRequests(t *testing.T, path string) {
	t.Helper()
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store, err := openExisting(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	record, err := store.GetInbound(ctx, "request-private")
	if err != nil || record == nil {
		t.Fatalf("seed request = %v, %v", record, err)
	}
	for i, id := range []string{"request-m", "request-z", "request-a"} {
		input := record.Snapshot
		input.RequestID = id
		input.Source = model.SourceKey{Channel: model.Telegram, AccountID: "bot", EventID: id}
		input.AcceptedAt = time.Date(2025, 1, i+1, 0, 0, 0, 0, time.UTC)
		input.ReceivedAt = input.AcceptedAt
		if _, err = store.AcceptInbound(ctx, input, nil); err != nil {
			t.Fatal(err)
		}
	}
}
