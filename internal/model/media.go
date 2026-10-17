package model

import (
	"context"
	"time"
)

type MediaKind string

const (
	Image MediaKind = "image"
	Audio MediaKind = "audio"
	Video MediaKind = "video"
	File  MediaKind = "file"
)

type MediaUpload struct {
	Kind           MediaKind `json:"kind"`
	MIMEType       string    `json:"mimeType"`
	FileName       string    `json:"fileName"`
	DurationMS     *int64    `json:"durationMs,omitempty"`
	PreviewMediaID string    `json:"previewMediaId,omitempty"`
	// Bytes are passed in memory and excluded from durable JSON snapshots.
	Data []byte `json:"-"`
}

type MediaReference struct {
	ID             string    `json:"id"`
	Kind           MediaKind `json:"kind"`
	MIMEType       string    `json:"mimeType"`
	FileName       string    `json:"fileName"`
	DurationMS     *int64    `json:"durationMs,omitempty"`
	PreviewMediaID string    `json:"previewMediaId,omitempty"`
	Size           int64     `json:"size"`
	SHA256         string    `json:"sha256"`
}

type StoredMedia struct {
	Reference MediaReference `json:"reference"`
	Data      []byte         `json:"-"`
}

type MediaLimits struct {
	MaxBytes       int64 `json:"maxBytes"`
	MaxTotalBytes  int64 `json:"maxTotalBytes"`
	MaxAttachments int   `json:"maxAttachments"`
}

// AgentAttachment selects an existing ID or new upload, with an optional native preview.
// Exactly one of MediaID and Upload must be set.
type AgentAttachment struct {
	MediaID string
	Upload  *MediaUpload
	Preview *MediaUpload
}

type PutMediaInput struct {
	ChannelID   string
	Agent       AgentKind
	EndpointIDs []string
	Media       StoredMedia
	Limits      MediaLimits
}

type PutMediaResult struct {
	Status    Outcome
	Reference *MediaReference
}

// MediaStorage atomically checks current ownership and budgets before inserting bytes.
// Metadata can outlive redacted bytes for keyed-send recovery.
type MediaStorage interface {
	GetReference(context.Context, string, string) (*MediaReference, error)
	GetMedia(context.Context, string, string) (*StoredMedia, error)
	PutMedia(context.Context, PutMediaInput) (PutMediaResult, error)
}

type AgentMediaHost interface {
	Limits() MediaLimits
	Authorize(context.Context, string) (bool, error)
	Upload(context.Context, string, string, MediaUpload) (*MediaReference, error)
	Read(context.Context, string, string) (*StoredMedia, error)
}

type ChannelMediaHost interface {
	Publish(context.Context, string, string, time.Duration) (string, error)
}
