import type { Json, EpochMs } from './values.js'
import type { ChannelId, EndpointConfig } from './config.js'
import type { MediaUpload, MediaReference, StoredMedia } from './media.js'

/** Platform-specific durable address, never a reply closure or ephemeral reply token. */
export type ReplyTarget = {
  readonly channel: ChannelId
  readonly accountId: string
  readonly chatId: string
  readonly threadId?: string
  readonly replyToId?: string
  readonly data: Json
}

export type SourceKey = {
  readonly channel: ChannelId
  readonly accountId: string
  readonly eventId: string
}

export type TraceContext = {
  readonly traceparent: string
  readonly tracestate?: string
}

export type IngestInput = {
  readonly source: SourceKey
  readonly senderId: string
  readonly text: string
  readonly attachments?: readonly MediaUpload[]
  readonly target: ReplyTarget
  readonly receivedAt: EpochMs
  readonly context: Json
  readonly trace?: TraceContext
}

export type InboundSnapshot = {
  readonly attachments?: readonly MediaReference[]
  readonly requestId: string
  readonly endpoint: EndpointConfig
  readonly acceptedAt: EpochMs
} & Omit<IngestInput, 'attachments'>

export type AttemptStatus = 'due' | 'accepted' | 'rejected' | 'unknown'

export type OutboundMessage = {
  readonly messageId: string
  readonly text: string
  readonly attachments?: readonly MediaReference[]
  readonly createdAt: EpochMs
}

export type AttemptState = {
  readonly status: AttemptStatus
  readonly attempts: number
  readonly dueAt: EpochMs
  readonly errorCode?: string
  readonly lease?: Lease
}

export type Lease = {
  readonly token: string
  readonly version: number
  readonly expiresAt: EpochMs
}

export type InboundRecord = {
  readonly snapshot: InboundSnapshot
  readonly version: number
  readonly dispatch: AttemptState
  readonly redactedAt?: EpochMs
}

export type DeliveryChunk = {
  readonly text: string
  /** A media chunk has empty text; preceding text chunks preserve the caption. */
  readonly media?: MediaReference
  readonly idempotencyKey: string
  readonly state: Json
}

export type SendReceipt = {
  readonly platformMessageId?: string
  readonly data?: Json
}

export type DeliveryStatus = 'pending' | 'sent' | 'rejected' | 'unknown'

export type OutboundRecord = {
  readonly deliveryId: string
  readonly requestId: string
  readonly messageId: string
  readonly target: ReplyTarget
  readonly chunks: readonly DeliveryChunk[]
  readonly currentChunk: number
  readonly receipts: readonly SendReceipt[]
  readonly status: DeliveryStatus
  readonly version: number
  readonly attempts: number
  readonly dueAt: EpochMs
  readonly createdAt: EpochMs
  readonly lease?: Lease
  readonly errorCode?: string
  readonly trace?: TraceContext
}

export type IngestReceipt = {
  readonly requestId: string
  readonly duplicate: boolean
}

export type MessageReceipt =
  | {
      readonly status: 'queued'
      readonly deliveryId: string
      readonly replay: boolean
    }
  | { readonly status: 'not_found' | 'unauthorized' | 'conflict' }

export type MutationResult =
  | { readonly status: 'updated'; readonly version: number }
  | { readonly status: 'not_found' | 'conflict' | 'unauthorized' }

export type DispatchResult =
  | { readonly status: 'accepted' }
  | {
      readonly status: 'retryable'
      readonly errorCode: string
      readonly retryAfterMs?: number
    }
  | { readonly status: 'rejected' | 'unknown'; readonly errorCode: string }

export type SendResult =
  | { readonly status: 'sent'; readonly receipt: SendReceipt }
  /** A durable reply is waiting for platform retrieval; checking it is not a failed send attempt. */
  | { readonly status: 'pending'; readonly retryAfterMs: number }
  | {
      readonly status: 'retryable'
      readonly errorCode: string
      readonly retryAfterMs?: number
    }
  | { readonly status: 'rejected' | 'unknown'; readonly errorCode: string }

export type SendInput = {
  readonly deliveryId: string
  readonly requestId: string
  readonly target: ReplyTarget
  readonly chunk: DeliveryChunk
  readonly chunkIndex: number
  /** Total persisted chunks, allowing callback transports to publish one completed reply. */
  readonly chunkCount?: number
  /** Resolved by core from durable storage, bound to this request and chunk. */
  readonly media?: StoredMedia
  /** Preview resolved from the same request by core. */
  readonly preview?: StoredMedia
  readonly signal: AbortSignal
}

export type DispatchInput = {
  readonly request: InboundSnapshot
  readonly signal: AbortSignal
}
