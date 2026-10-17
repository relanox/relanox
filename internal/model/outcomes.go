package model

// Outcome is a durable operation result, separate from transport errors.
type Outcome string

const (
	Accepted            Outcome = "accepted"
	Sent                Outcome = "sent"
	Pending             Outcome = "pending"
	Retryable           Outcome = "retryable"
	Rejected            Outcome = "rejected"
	Unknown             Outcome = "unknown"
	Queued              Outcome = "queued"
	Updated             Outcome = "updated"
	Stored              Outcome = "stored"
	NotFound            Outcome = "not_found"
	Unauthorized        Outcome = "unauthorized"
	Conflict            Outcome = "conflict"
	AwaitingFinal       Outcome = "awaiting_final"
	Expired             Outcome = "expired"
	InvalidMediaPreview Outcome = "invalid_media_preview"
	MediaTooLarge       Outcome = "media_too_large"
	TooManyAttachments  Outcome = "too_many_attachments"
	MediaTotalTooLarge  Outcome = "media_total_too_large"
)
