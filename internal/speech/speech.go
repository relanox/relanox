// Package speech prepares captured incoming audio through Tencent's native ASR
// API. Original text/media and routing remain owned by the durable core.
package speech

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/relanox/relanox/internal/config"
	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/transport"
)

const componentID = "speech-tencent"

type Options struct {
	ResolveSecret func(model.SecretRef) (string, error)
	HTTPClient    *http.Client
	Observer      model.Observer
}

type Preparer struct {
	cfg     config.Speech
	options Options
}

var _ model.Preparer = (*Preparer)(nil)

type capturedOptions struct {
	Engine    string          `json:"engine"`
	Region    string          `json:"region"`
	SecretID  model.SecretRef `json:"secretId"`
	SecretKey model.SecretRef `json:"secretKey"`
}

type Transcription struct {
	MediaID   string `json:"mediaId"`
	Status    string `json:"status"`
	Text      string `json:"text,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
}

func New(cfg config.Speech, options Options) (*Preparer, error) {
	if cfg.EngineModelType == "" {
		cfg.EngineModelType = "16k_zh"
	}
	if err := config.ValidateSpeech(cfg); err != nil {
		return nil, err
	}
	if cfg.Enabled && options.ResolveSecret == nil {
		return nil, errors.New("speech_secret_resolver_required")
	}
	if options.HTTPClient == nil {
		options.HTTPClient = transport.NewClient(transport.Options{Timeout: 8 * time.Second, AllowedHosts: []string{"asr.tencentcloudapi.com"}})
	}
	return &Preparer{cfg: cfg, options: options}, nil
}

func (*Preparer) ID() string { return componentID }

func (p *Preparer) Plan(message model.AgentMessage) (*model.PreparationPlan, error) {
	if !p.cfg.Enabled {
		return nil, nil
	}
	for _, ref := range message.Attachments {
		if ref.Kind == model.Audio {
			options, err := json.Marshal(capturedOptions{Engine: p.cfg.EngineModelType, Region: p.cfg.Region, SecretID: p.cfg.SecretID, SecretKey: p.cfg.SecretKey})
			return &model.PreparationPlan{ID: componentID, Options: options}, err
		}
	}
	return nil, nil
}

func decodeOptions(data json.RawMessage) (capturedOptions, error) {
	var options capturedOptions
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&options); err != nil {
		return options, errors.New("invalid_captured_speech_options")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return options, errors.New("invalid_captured_speech_options")
	}
	if options.Engine == "" {
		return options, errors.New("invalid_captured_speech_options")
	}
	err := config.ValidateSpeech(config.Speech{Enabled: true, EngineModelType: options.Engine, Region: options.Region, SecretID: options.SecretID, SecretKey: options.SecretKey})
	return options, err
}

func (p *Preparer) Process(ctx context.Context, input model.PreparationInput) (model.PreparationOutput, error) {
	if !p.cfg.Enabled || input.ReadMedia == nil {
		return model.PreparationOutput{}, errors.New("speech_disabled_or_media_unavailable")
	}
	options, err := decodeOptions(input.Options)
	if err != nil {
		return model.PreparationOutput{}, err
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	transcriptions := p.recognizeAll(ctx, input, options)
	parts := []string{input.Message.Text}
	for _, result := range transcriptions {
		if result.Status == "transcribed" {
			parts = append(parts, "[Voice transcript: "+result.MediaID+"]\n"+result.Text)
		}
		p.record(ctx, input.Message.RequestID, result)
	}
	if p.options.Observer != nil {
		p.options.Observer.Record("relanox_transcription_duration_seconds", time.Since(started).Seconds(), model.MetricLabels{Component: componentID, Operation: "prepare"})
	}
	data, err := json.Marshal(struct {
		Transcriptions []Transcription `json:"transcriptions"`
	}{transcriptions})
	if len(parts) > 1 && parts[0] == "" {
		parts = parts[1:]
	}
	return model.PreparationOutput{Text: strings.Join(parts, "\n\n"), Data: data}, err
}

func (p *Preparer) recognizeAll(ctx context.Context, input model.PreparationInput, options capturedOptions) []Transcription {
	var audio []model.MediaReference
	for _, ref := range input.Message.Attachments {
		if ref.Kind == model.Audio {
			audio = append(audio, ref)
		}
	}
	results := make([]Transcription, len(audio))
	var next atomic.Int64
	var workers sync.WaitGroup
	for range min(4, len(audio)) {
		workers.Go(func() {
			for {
				index := int(next.Add(1) - 1)
				if index >= len(audio) {
					return
				}
				results[index] = p.recognizeClip(ctx, input.ReadMedia, audio[index], options)
			}
		})
	}
	workers.Wait()
	return results
}

func (p *Preparer) recognizeClip(ctx context.Context, read func(context.Context, string) (*model.StoredMedia, error), ref model.MediaReference, options capturedOptions) Transcription {
	result := Transcription{MediaID: ref.ID, Status: "failed", ErrorCode: "media_unavailable"}
	if ctx.Err() != nil {
		result.ErrorCode = "timeout"
		return result
	}
	media, err := read(ctx, ref.ID)
	if ctx.Err() != nil {
		result.ErrorCode = "timeout"
		return result
	}
	if err != nil || media == nil || media.Reference.ID != ref.ID || media.Reference.Kind != model.Audio {
		return result
	}
	text, code := p.recognize(ctx, *media, options)
	if code != "" {
		result.ErrorCode = code
		return result
	}
	return Transcription{MediaID: ref.ID, Status: "transcribed", Text: text}
}

func (p *Preparer) record(ctx context.Context, requestID string, result Transcription) {
	if p.options.Observer == nil {
		return
	}
	p.options.Observer.Count("relanox_transcription_total", model.MetricLabels{Component: componentID, Outcome: result.Status}, 1)
	if result.Status == "failed" {
		p.options.Observer.Log(ctx, "warn", "transcription.failed", model.LogFields{Component: componentID, RequestID: requestID, ErrorCode: result.ErrorCode})
	}
}
