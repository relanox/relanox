package model

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type LengthUnit string

const (
	UTF16     LengthUnit = "utf16"
	Codepoint LengthUnit = "codepoint"
	UTF8      LengthUnit = "utf8"
)

type TransportKind string

const (
	HTTPTransport       TransportKind = "http"
	ConnectionTransport TransportKind = "connection"
	BothTransports      TransportKind = "both"
)

type RichTextLimits struct {
	MaxParts           int      `json:"maxParts"`
	MaxTextLength      int      `json:"maxTextLength"`
	ImageMIMETypes     []string `json:"imageMimeTypes,omitempty"`
	MaxImageBytes      int64    `json:"maxImageBytes,omitempty"`
	MaxTotalImageBytes int64    `json:"maxTotalImageBytes,omitempty"`
}

type MediaCapabilities struct {
	Receive []MediaKind `json:"receive"`
	Send    []MediaKind `json:"send"`
}

type ChannelCapabilities struct {
	Transport               TransportKind
	MaxTextLength           int
	MaxTextLengthPerMessage int
	LengthUnit              LengthUnit
	IdempotentSend          bool
	MaxChunksPerMessage     int
	MaxAttachments          int
	RichText                *RichTextLimits
	Media                   MediaCapabilities
}

type ConnectionStatus string

const (
	Connected    ConnectionStatus = "connected"
	Disconnected ConnectionStatus = "disconnected"
	Degraded     ConnectionStatus = "degraded"
)

// Availability is a snapshot. Send must recheck expiring native permissions.
type ChannelResolution struct {
	Available bool
	Target    *ReplyTarget
	Reason    string
}

type AgentChannelStatus struct {
	Channel                 ChannelAddress      `json:"channel"`
	Connection              ConnectionStatus    `json:"connection"`
	Send                    ChannelAvailability `json:"send"`
	Media                   []MediaKind         `json:"media"`
	RichText                string              `json:"richText,omitempty"`
	RichTextLimits          *RichTextLimits     `json:"richTextLimits,omitempty"`
	MaxTextLength           int                 `json:"maxTextLength"`
	LengthUnit              LengthUnit          `json:"lengthUnit"`
	MaxTextLengthPerMessage int                 `json:"maxTextLengthPerMessage,omitempty"`
	MaxChunksPerMessage     int                 `json:"maxChunksPerMessage,omitempty"`
	MaxAttachments          int                 `json:"maxAttachments,omitempty"`
}

type ChannelAvailability struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

type RequestStatus struct {
	ID    string      `json:"id"`
	Reply ReplyStatus `json:"reply"`
}

type DeliverySummary struct {
	ID        string         `json:"id"`
	Channel   string         `json:"channel"`
	Status    DeliveryStatus `json:"status"`
	ErrorCode string         `json:"errorCode,omitempty"`
}

type AgentStatus struct {
	Request     *RequestStatus       `json:"request,omitempty"`
	MediaLimits MediaLimits          `json:"mediaLimits"`
	Channels    []AgentChannelStatus `json:"channels"`
	Delivery    *DeliverySummary     `json:"delivery,omitempty"`
}

type ReadMessagesInput struct {
	RequestID string
	Pending   bool
	Cursor    *MessageCursor
	Limit     int
}

type StatusInput struct {
	DeliveryID string
	RequestID  string
}

type SendMessageInput struct {
	Channel        string
	IdempotencyKey string
	Reply          *ReplyReference
	Text           string
	Attachments    []AgentAttachment
}

// ScopedAgentHost rechecks active endpoint/channel ownership on every operation.
type ScopedAgentHost interface {
	ReadMessages(context.Context, ReadMessagesInput) ([]AgentMessage, error)
	Status(context.Context, StatusInput) (AgentStatus, error)
	SendMessage(context.Context, SendMessageInput) (MessageReceipt, error)
	Media() AgentMediaHost
}

// Principals must originate from verified protocol authentication.
type AgentHost interface {
	CommonHost
	ForPrincipal(context.Context, Principal) (ScopedAgentHost, error)
}

type DiscoveredConversation struct {
	ChatID   string `json:"chatId"`
	SenderID string `json:"senderId"`
	ThreadID string `json:"threadId,omitempty"`
}

// ChannelHost is scoped by its constructor to one configured account. The
// receiver must reject Ingest inputs that try to change that scope.
type ChannelHost interface {
	CommonHost
	Ingest(context.Context, IngestInput) (IngestReceipt, error)
	BoundChatIDs() []string
	DiscoverConversation(context.Context, DiscoveredConversation) error
	MaxMediaBytes() int64
	Media() ChannelMediaHost
}

// CommonHost supplies production dependencies within the constructor's fixed
// component/account scope. MountHTTP must reject duplicate or escaping routes.
type CommonHost interface {
	PublicURL() string
	State() StateStore
	Observer() Observer
	MountHTTP(HTTPRoute) error
	Connection(ConnectionStatus, string)
}

// HTTP routes are mounted explicitly by the application; no runtime loading or
// component discovery is involved. Authentication runs before reading large bodies.
type HTTPRoute struct {
	Pattern      string
	Handler      http.Handler
	MaxBodyBytes int64
	Authorize    func(*http.Request) error
}

// Channel and Agent implementations receive scoped hosts, state and credential
// references in constructors that validate offline and mount explicit HTTP routes.
// Start initiates connections and background loops, then returns; it must not block
// for the service lifetime. Its context owns those loops until cancellation.
// Close stops and joins workers within the supplied shutdown deadline. Validation
// must remain independently usable without constructors or network connections.
type Channel interface {
	Kind() ChannelKind
	Capabilities() ChannelCapabilities
	Start(context.Context) error
	Close(context.Context) error
	Resolve(context.Context, ChannelAddress, *ReplyTarget) (ChannelResolution, error)
	SplitText(string, ReplyTarget) ([]string, error)
	Send(context.Context, SendInput) (SendResult, error)
}

type Agent interface {
	Kind() AgentKind
	Start(context.Context) error
	Close(context.Context) error
	Dispatch(context.Context, DispatchInput) (DispatchResult, error)
}

type StateNamespace struct {
	Component string `json:"component"`
	OwnerID   string `json:"ownerId"`
}

type StateEntry struct {
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	Version   int64           `json:"version"`
	ExpiresAt *time.Time      `json:"expiresAt,omitempty"`
}

type ListStateInput struct {
	Prefix        string
	ExpiresBefore *time.Time
	Limit         int
}

type CompareAndSetStateInput struct {
	Key             string
	ExpectedVersion *int64
	Value           json.RawMessage
	ExpiresAt       *time.Time
}

// A nil ExpectedVersion inserts only if no entry exists, including expired rows.
type StateStore interface {
	Get(context.Context, string) (*StateEntry, error)
	List(context.Context, ListStateInput) ([]StateEntry, error)
	CompareAndSet(context.Context, CompareAndSetStateInput) (MutationResult, error)
	Delete(context.Context, string, int64) (MutationResult, error)
}

// Preparation is a statically composed pipeline (for example Tencent speech).
// A filtered output suppresses notification but preserves original content.
type PreparationPlan struct {
	ID      string          `json:"id"`
	Options json.RawMessage `json:"options,omitempty"`
}

type PreparationOutput struct {
	Text     string          `json:"text"`
	Data     json.RawMessage `json:"data,omitempty"`
	Filtered bool            `json:"filtered,omitempty"`
}

type PreparationResult struct {
	ID        string             `json:"id"`
	Status    string             `json:"status"`
	Output    *PreparationOutput `json:"output,omitempty"`
	ErrorCode string             `json:"errorCode,omitempty"`
}

type PreparationInput struct {
	Message   AgentMessage
	Options   json.RawMessage
	ReadMedia func(context.Context, string) (*StoredMedia, error)
}

type Preparer interface {
	ID() string
	Plan(AgentMessage) (*PreparationPlan, error)
	Process(context.Context, PreparationInput) (PreparationOutput, error)
}

// Log fields are deliberately closed so ordinary operational events cannot
// accidentally capture message contents, account credentials or HTTP headers.
type LogFields struct {
	Component  string
	ChannelID  string
	RequestID  string
	DeliveryID string
	TraceID    string
	ErrorCode  string
	Outcome    string
	Operation  string
}

type MetricLabels struct {
	Channel    ChannelKind
	Agent      AgentKind
	Component  string
	Operation  string
	Outcome    string
	ErrorClass string
}

type Span interface {
	Context() *TraceContext
	End(string)
}

type Observer interface {
	Log(context.Context, string, string, LogFields)
	Count(string, MetricLabels, int64)
	Record(string, float64, MetricLabels)
	Span(context.Context, string, LogFields, *TraceContext) (context.Context, Span)
}
