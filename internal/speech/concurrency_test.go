package speech_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/speech"
)

// All accepted attachments must reach Tencent before any recognition completes.
// Twelve clips exceed the default attachment limit of ten, which is configurable
// rather than a protocol cap. Smaller fixtures miss hidden concurrency limits.
// The TLS peer implements only the documented SentenceRecognition HTTP API:
// https://cloud.tencent.com/document/api/1093/35646
func TestAllAcceptedAudioClipsStartRecognitionIndependently(t *testing.T) {
	started := make(chan struct{}, 12)
	release := make(chan struct{})
	peer := &asrPeer{server: httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Error(err)
			return
		}
		started <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		if _, err := io.WriteString(w, `{"Response":{"Result":"concurrent transcript"}}`); err != nil {
			t.Error(err)
		}
	}))}
	defer peer.server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	preparer := newConcurrentPreparer(t, peer)
	media := make([]model.StoredMedia, 12)
	for i := range media {
		media[i] = model.StoredMedia{Reference: model.MediaReference{ID: "clip-" + strconv.Itoa(i), Kind: model.Audio, MIMEType: "audio/wav"}, Data: []byte("abc")}
	}
	input := speechInput(t, preparer, media)
	completed := make(chan model.PreparationOutput, 1)
	go func() {
		output, err := preparer.Process(ctx, input)
		if err != nil {
			t.Error(err)
		}
		completed <- output
	}()
	count := 0
	for count < 12 {
		select {
		case <-started:
			count++
		case <-ctx.Done():
			close(release)
			t.Fatalf("only %d of twelve clips reached native recognition before any completed", count)
		}
	}
	close(release)
	select {
	case output := <-completed:
		assertTranscribedClips(t, output, 12)
	case <-ctx.Done():
		t.Fatal("independent recognition did not complete")
	}
}

// Recognition gets its own eight-second provider budget after reading media.
// A slow media read must not consume another clip's provider timeout. A shared
// process deadline cuts this valid four-second HTTP response short; cancellation
// coverage alone only proves that an explicitly cancelled parent stops I/O.
func TestRecognitionBudgetStartsForEachClipAfterMediaRead(t *testing.T) {
	peer := &asrPeer{server: httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Error(err)
			return
		}
		timer := time.NewTimer(4 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-r.Context().Done():
			return
		}
		if _, err := io.WriteString(w, `{"Response":{"Result":"independent budget transcript"}}`); err != nil {
			t.Error(err)
		}
	}))}
	defer peer.server.Close()
	preparer := newConcurrentPreparer(t, peer)
	media := []model.StoredMedia{{Reference: model.MediaReference{ID: "slow-media", Kind: model.Audio, MIMEType: "audio/wav"}, Data: []byte("abc")}}
	input := speechInput(t, preparer, media)
	input.ReadMedia = func(ctx context.Context, _ string) (*model.StoredMedia, error) {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
			return &media[0], nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	output, err := preparer.Process(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	assertTranscribedClips(t, output, 1)
}

// The independent budget must also cancel real HTTP, not merely let every clip
// use the parent's longer lifetime. Explicit parent-cancel tests do not exercise
// an eight-second provider expiration or its stable timeout fallback code.
func TestRecognitionBudgetCancelsProviderBeforeParent(t *testing.T) {
	peer := newASRPeer(t, "", true)
	preparer := newConcurrentPreparer(t, peer)
	input := speechInput(t, preparer, []model.StoredMedia{{Reference: model.MediaReference{ID: "held", Kind: model.Audio, MIMEType: "audio/wav"}, Data: []byte("abc")}})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	done := make(chan model.PreparationOutput, 1)
	go func() {
		output, err := preparer.Process(ctx, input)
		if err != nil {
			t.Error(err)
		}
		done <- output
	}()
	select {
	case output := <-done:
		if output.Text != input.Message.Text || !strings.Contains(string(output.Data), `"errorCode":"timeout"`) || ctx.Err() != nil {
			t.Fatalf("provider expiration did not preserve parent/fallback: %+v", output)
		}
	case <-time.After(12 * time.Second):
		t.Fatal("recognition used the longer parent lifetime")
	}
	select {
	case <-peer.cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("provider expiration did not reach HTTP")
	}
}

func newConcurrentPreparer(t *testing.T, peer *asrPeer) *speech.Preparer {
	t.Helper()
	preparer, err := speech.New(speechConfig(), speech.Options{HTTPClient: peer.client(), ResolveSecret: func(model.SecretRef) (string, error) { return "fixture", nil }})
	if err != nil {
		t.Fatal(err)
	}
	return preparer
}

func assertTranscribedClips(t *testing.T, output model.PreparationOutput, want int) {
	t.Helper()
	var data struct {
		Transcriptions []speech.Transcription `json:"transcriptions"`
	}
	if err := json.Unmarshal(output.Data, &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Transcriptions) != want {
		t.Fatalf("transcriptions=%+v, want %d clips", data.Transcriptions, want)
	}
	for _, clip := range data.Transcriptions {
		if clip.Status != "transcribed" || clip.Text == "" || clip.ErrorCode != "" {
			t.Fatalf("valid clip lost its own recognition budget: %+v", clip)
		}
	}
}
