package model

import (
	"context"
	"time"
)

type StorageStats struct {
	Pending         int64      `json:"pending"`
	Undelivered     int64      `json:"undelivered"`
	Unknown         int64      `json:"unknown"`
	OldestPendingAt *time.Time `json:"oldestPendingAt,omitempty"`
}

type Health struct {
	OK        bool   `json:"ok"`
	ErrorCode string `json:"errorCode,omitempty"`
}

type EnqueueMessageInput struct {
	ChannelID   string
	EndpointIDs []string
	Agent       AgentKind
	Message     OutboundMessage
	Outbound    OutboundRecord
	Media       []StoredMedia
	Limits      MediaLimits
}

type MessageReceiptInput struct {
	ChannelID   string
	EndpointIDs []string
	Agent       AgentKind
	Message     OutboundMessage
}

type WorkKind string

const (
	PrepareWork  WorkKind = "prepare"
	DispatchWork WorkKind = "dispatch"
	SendWork     WorkKind = "send"
)

// Exactly one record must match Kind. Claim and settlement are atomic and fenced
// by token plus version; expired ambiguous effects cannot be silently retried.
type DueWork struct {
	Kind     WorkKind
	Inbound  *InboundRecord
	Outbound *OutboundRecord
	Lease    Lease
}

type TakeDueInput struct {
	Now                 time.Time
	LeaseDuration       time.Duration
	SendLeaseDuration   time.Duration
	Limit               int
	LeaseOwner          string
	SafeRetryAccountIDs []string
	PreferredKind       WorkKind
}

type Settlement struct {
	Kind        WorkKind
	ID          string
	Lease       Lease
	Preparation []PreparationResult
	Dispatch    *DispatchResult
	Send        *SendResult
	NextDueAt   time.Time
	Now         time.Time
}

type RequeueInput struct {
	Kind               WorkKind
	ID                 string
	ExpectedVersion    int64
	Now                time.Time
	AcknowledgeUnknown bool
}

type StatusFilter struct {
	DispatchStatus AttemptStatus
	DeliveryStatus DeliveryStatus
	EndpointID     string
	Limit          int
	AfterID        string
}

type ListInboundInput struct {
	StatusFilter
	Recent     bool
	ChannelIDs []string
	ReadyOnly  bool
}

type ListPendingInboundInput struct {
	ChannelIDs  []string
	EndpointIDs []string
	Limit       int
	Cursor      *MessageCursor
}

type CleanupInput struct {
	Before time.Time
	Limit  int
}

// Storage is implemented with typed schema/query/transaction APIs. SQL dialect
// details never cross this boundary. Initialization must refuse incompatible
// legacy databases rather than destroy or silently rebuild them.
type Storage interface {
	MediaStorage
	RegisterConversations(context.Context, []ConversationRecord) error
	GetConversation(context.Context, string, bool) (*ConversationRecord, error)
	AcceptInbound(context.Context, InboundSnapshot, []StoredMedia) (IngestReceipt, error)
	GetMessageReceipt(context.Context, MessageReceiptInput) (MessageReceipt, error)
	EnqueueMessage(context.Context, EnqueueMessageInput) (MessageReceipt, error)
	Requeue(context.Context, RequeueInput) (MutationResult, error)
	TakeDue(context.Context, TakeDueInput) ([]DueWork, error)
	SettleAttempt(context.Context, Settlement) (MutationResult, error)
	GetState(context.Context, StateNamespace, string) (*StateEntry, error)
	ListState(context.Context, StateNamespace, ListStateInput) ([]StateEntry, error)
	CompareAndSetState(context.Context, StateNamespace, CompareAndSetStateInput) (MutationResult, error)
	DeleteState(context.Context, StateNamespace, string, int64) (MutationResult, error)
	GetInbound(context.Context, string) (*InboundRecord, error)
	GetOutbound(context.Context, string) (*OutboundRecord, error)
	ListInbound(context.Context, ListInboundInput) ([]InboundRecord, error)
	ListPendingInbound(context.Context, ListPendingInboundInput) ([]InboundRecord, error)
	ListOutbound(context.Context, StatusFilter) ([]OutboundRecord, error)
	Stats(context.Context) (StorageStats, error)
	Cleanup(context.Context, CleanupInput) (int64, error)
	Initialize(context.Context) error
	Health(context.Context) (Health, error)
	Close() error
}
