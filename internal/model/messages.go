package model

import (
	"encoding/json"
	"time"
)

type SourceKey struct {
	Channel   ChannelKind `json:"channel"`
	AccountID string      `json:"accountId"`
	EventID   string      `json:"eventId"`
}

type TraceContext struct {
	Traceparent string `json:"traceparent"`
	Tracestate  string `json:"tracestate,omitempty"`
}

type IngestInput struct {
	Source      SourceKey       `json:"source"`
	SenderID    string          `json:"senderId"`
	Text        string          `json:"text"`
	Attachments []MediaUpload   `json:"-"`
	Target      ReplyTarget     `json:"target"`
	ReceivedAt  time.Time       `json:"receivedAt"`
	Context     json.RawMessage `json:"context,omitempty"`
	Trace       *TraceContext   `json:"trace,omitempty"`
}

// InboundSnapshot contains no transient byte uploads; acceptance persists the
// snapshot and all media in one transaction before returning a receipt.
type InboundSnapshot struct {
	Source      SourceKey         `json:"source"`
	SenderID    string            `json:"senderId"`
	Text        string            `json:"text"`
	Target      ReplyTarget       `json:"target"`
	ReceivedAt  time.Time         `json:"receivedAt"`
	Context     json.RawMessage   `json:"context,omitempty"`
	Trace       *TraceContext     `json:"trace,omitempty"`
	Preparation []PreparationPlan `json:"preparation,omitempty"`
	Channel     ChannelAddress    `json:"channel"`
	Attachments []MediaReference  `json:"attachments,omitempty"`
	RequestID   string            `json:"requestId"`
	Endpoint    EndpointConfig    `json:"endpoint"`
	AcceptedAt  time.Time         `json:"acceptedAt"`
}

type ReplyKind string

const (
	Progress ReplyKind = "progress"
	Final    ReplyKind = "final"
)

// A progress reply never completes a request; a request has at most one final delivery.
type ReplyReference struct {
	RequestID string    `json:"requestId"`
	Kind      ReplyKind `json:"kind"`
}

type ReplyStatus struct {
	Status     Outcome `json:"status"`
	DeliveryID string  `json:"deliveryId,omitempty"`
	ErrorCode  string  `json:"errorCode,omitempty"`
}

// AgentMessage omits captured endpoint credentials and private native reply targets.
type AgentMessage struct {
	RequestID   string                     `json:"requestId"`
	AcceptedAt  time.Time                  `json:"acceptedAt"`
	Channel     ChannelAddress             `json:"channel"`
	SenderID    string                     `json:"senderId"`
	Text        string                     `json:"text"`
	Context     json.RawMessage            `json:"context,omitempty"`
	Attachments []MediaReference           `json:"attachments,omitempty"`
	Reply       *ReplyStatus               `json:"reply,omitempty"`
	Extensions  map[string]json.RawMessage `json:"extensions,omitempty"`
}

type MessageCursor struct {
	AcceptedAt time.Time `json:"acceptedAt"`
	RequestID  string    `json:"requestId"`
}

type AttemptStatus Outcome

const (
	AttemptDue      AttemptStatus = "due"
	AttemptAccepted AttemptStatus = "accepted"
	AttemptRejected AttemptStatus = "rejected"
	AttemptUnknown  AttemptStatus = "unknown"
)

type Lease struct {
	Token     string    `json:"token"`
	Version   int64     `json:"version"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type AttemptState struct {
	Status    AttemptStatus `json:"status"`
	Attempts  int           `json:"attempts"`
	DueAt     time.Time     `json:"dueAt"`
	ErrorCode string        `json:"errorCode,omitempty"`
	Lease     *Lease        `json:"lease,omitempty"`
}

type InboundRecord struct {
	Preparation     []PreparationResult `json:"preparation,omitempty"`
	FinalDeliveryID string              `json:"finalDeliveryId,omitempty"`
	Snapshot        InboundSnapshot     `json:"snapshot"`
	Version         int64               `json:"version"`
	Dispatch        AttemptState        `json:"dispatch"`
	RedactedAt      *time.Time          `json:"redactedAt,omitempty"`
}

type RichTextPart struct {
	Type  string          `json:"type"`
	Text  string          `json:"text,omitempty"`
	Media *MediaReference `json:"media,omitempty"`
	Label string          `json:"label,omitempty"`
}

type DeliveryChunk struct {
	Text           string          `json:"text"`
	Media          *MediaReference `json:"media,omitempty"`
	RichText       []RichTextPart  `json:"richText,omitempty"`
	IdempotencyKey string          `json:"idempotencyKey"`
	State          json.RawMessage `json:"state,omitempty"`
}

type SendReceipt struct {
	PlatformMessageID string          `json:"platformMessageId,omitempty"`
	Data              json.RawMessage `json:"data,omitempty"`
}

type DeliveryStatus Outcome

const (
	DeliveryPending  DeliveryStatus = "pending"
	DeliverySent     DeliveryStatus = "sent"
	DeliveryRejected DeliveryStatus = "rejected"
	DeliveryUnknown  DeliveryStatus = "unknown"
)

type OutboundMessage struct {
	Reply       *ReplyReference  `json:"reply,omitempty"`
	MessageID   string           `json:"messageId"`
	Text        string           `json:"text"`
	Attachments []MediaReference `json:"attachments,omitempty"`
	CreatedAt   time.Time        `json:"createdAt"`
}

type OutboundRecord struct {
	Reply        *ReplyReference `json:"reply,omitempty"`
	RedactedAt   *time.Time      `json:"redactedAt,omitempty"`
	DeliveryID   string          `json:"deliveryId"`
	ChannelID    string          `json:"channelId"`
	Endpoint     EndpointConfig  `json:"endpoint"`
	MessageID    string          `json:"messageId"`
	Target       ReplyTarget     `json:"target"`
	Chunks       []DeliveryChunk `json:"chunks"`
	CurrentChunk int             `json:"currentChunk"`
	Receipts     []SendReceipt   `json:"receipts"`
	Status       DeliveryStatus  `json:"status"`
	Version      int64           `json:"version"`
	Attempts     int             `json:"attempts"`
	DueAt        time.Time       `json:"dueAt"`
	CreatedAt    time.Time       `json:"createdAt"`
	Lease        *Lease          `json:"lease,omitempty"`
	ErrorCode    string          `json:"errorCode,omitempty"`
	Trace        *TraceContext   `json:"trace,omitempty"`
}

type IngestReceipt struct {
	RequestID string `json:"requestId"`
	Duplicate bool   `json:"duplicate"`
}

type MessageReceipt struct {
	Status     Outcome `json:"status"`
	DeliveryID string  `json:"deliveryId,omitempty"`
	Replay     bool    `json:"replay,omitempty"`
}

type MutationResult struct {
	Status  Outcome
	Version int64
}

// Transport outcomes are intentionally distinct from Go errors. Unknown means
// a remote side effect may have occurred and must not be blindly retried.
type DispatchResult struct {
	Status     Outcome
	ErrorCode  string
	RetryAfter time.Duration
}

type SendResult struct {
	Status     Outcome
	Receipt    *SendReceipt
	ErrorCode  string
	RetryAfter time.Duration
}

type SendInput struct {
	Reply      *ReplyReference
	DeliveryID string
	ChannelID  string
	Target     ReplyTarget
	Chunk      DeliveryChunk
	ChunkIndex int
	ChunkCount int
	Media      *StoredMedia
	Preview    *StoredMedia
	RichMedia  []StoredMedia
}

type DispatchInput struct {
	Request    InboundSnapshot
	Extensions map[string]json.RawMessage
}
