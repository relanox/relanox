package common

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
)

type Options struct {
	HTTPClient      *http.Client
	ResolveSecret   func(model.SecretRef) (string, error)
	TLSClientConfig *tls.Config
}

func (o Options) Secret(ref model.SecretRef) (string, error) {
	if o.ResolveSecret != nil {
		return o.ResolveSecret(ref)
	}
	return (config.Config{}).ResolveSecret(ref)
}

func (o Options) SecretValue(ref model.SecretRef) string {
	value, _ := o.Secret(ref)
	return value
}

func DecodeConfig(raw json.RawMessage, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return errors.New("invalid_channel_configuration")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("invalid_channel_configuration")
	}
	return nil
}

func Data(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		panic("invalid_native_state")
	}
	return raw
}

func MediaKind(mimeType string) model.MediaKind {
	switch {
	case strings.HasPrefix(mimeType, "image/"):
		return model.Image
	case strings.HasPrefix(mimeType, "audio/"):
		return model.Audio
	case strings.HasPrefix(mimeType, "video/"):
		return model.Video
	}
	return model.File
}

func MediaLimit(host model.ChannelHost) int64 {
	if host.MaxMediaBytes() > 0 {
		return host.MaxMediaBytes()
	}
	return 100 * 1024 * 1024
}

func AllMedia() []model.MediaKind {
	return []model.MediaKind{model.Image, model.Audio, model.Video, model.File}
}

func Sent(id string) model.SendResult {
	return model.SendResult{Status: model.Sent, Receipt: &model.SendReceipt{PlatformMessageID: id}}
}

func Reject(code string) model.SendResult {
	return model.SendResult{Status: model.Rejected, ErrorCode: code}
}

func Retry(code string, after time.Duration) model.SendResult {
	return model.SendResult{Status: model.Retryable, ErrorCode: code, RetryAfter: after}
}

func Failure(err error, preparing bool) model.SendResult {
	var native *HTTPError
	if errors.As(err, &native) {
		if native.Status == 429 {
			return Retry("rate_limited", RetryAfter(native.Header))
		}
		if native.Status == 401 {
			return Retry("oauth_token_rejected", 0)
		}
		if native.Status < 500 && native.Status != http.StatusRequestTimeout {
			return Reject("platform_request_rejected")
		}
	}
	if preparing {
		return Retry("native_preparation_failed", time.Second)
	}
	return model.SendResult{Status: model.Unknown, ErrorCode: "native_send_uncertain"}
}

func PolicyRejection(err error) bool {
	if err == nil {
		return false
	}
	// Core errors expose only stable public codes; never log the remote error.
	var coded interface{ Code() string }
	code := err.Error()
	if errors.As(err, &coded) {
		code = coded.Code()
	}
	return slices.Contains([]string{"sender_not_allowed", "unbound_conversation", "unauthorized_sender", "unauthorized_conversation", "unknown_account", "media_too_large", "too_many_attachments", "media_total_too_large"}, code)
}

func Ingest(ctx context.Context, host model.ChannelHost, input model.IngestInput) error {
	_, err := host.Ingest(ctx, input)
	if PolicyRejection(err) {
		return nil
	}
	return err
}

func ReadState[T any](ctx context.Context, state model.StateStore, key string) (T, *model.StateEntry, error) {
	var result T
	entry, err := state.Get(ctx, key)
	if err != nil || entry == nil {
		return result, entry, err
	}
	if err = json.Unmarshal(entry.Value, &result); err != nil {
		return result, entry, errors.New("invalid_native_state")
	}
	return result, entry, nil
}

func SaveState(ctx context.Context, state model.StateStore, key string, value any, expires *time.Time) error {
	for attempt := 0; attempt < 8; attempt++ {
		entry, err := state.Get(ctx, key)
		if err != nil {
			return err
		}
		var expected *int64
		if entry != nil {
			expected = &entry.Version
		}
		result, err := state.CompareAndSet(ctx, model.CompareAndSetStateInput{Key: key, ExpectedVersion: expected, Value: Data(value), ExpiresAt: expires})
		if err != nil {
			return err
		}
		if result.Status == model.Updated {
			return nil
		}
	}
	return errors.New("native_state_conflict")
}

type Lifecycle struct {
	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

func (l *Lifecycle) Start(parent context.Context, work func(context.Context)) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cancel != nil {
		return errors.New("channel_already_started")
	}
	if err := parent.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	l.cancel = cancel
	l.done = make(chan struct{})
	go func() { defer close(l.done); work(ctx) }()
	return nil
}

func (l *Lifecycle) Close(ctx context.Context) error {
	l.mu.Lock()
	cancel, done := l.cancel, l.done
	l.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
	}
	l.mu.Lock()
	l.cancel = nil
	l.mu.Unlock()
	return nil
}

func Delay(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
