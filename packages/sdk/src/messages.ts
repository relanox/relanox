import type { Json, EpochMs } from './values.js'
import type { ChannelId, EndpointConfig } from './config.js'
import type { MediaUpload, MediaReference, StoredMedia } from './media.js'

/** Platform-specific durable address, never a reply closure or ephemeral reply token. */
export interface ReplyTarget {
  readonly channel: ChannelId
  readonly accountId: string
  readonly chatId: string
  readonly threadId?: string
  readonly replyToId?: string
  readonly data: Json
}

export interface SourceKey {
  readonly channel: ChannelId
  readonly accountId: string
  readonly eventId: string
}

export interface TraceContext {
  readonly traceparent: string
  readonly tracestate?: string
}

export interface IngestInput {
  readonly source: SourceKey
  readonly senderId: string
  readonly text: string
  readonly attachments?: readonly MediaUpload[]
  readonly target: ReplyTarget
  readonly receivedAt: EpochMs
  readonly context: Json
  readonly trace?: TraceContext
}

export interface InboundSnapshot extends Omit<IngestInput, 'attachments'> {
  readonly attachments?: readonly MediaReference[]
  readonly requestId: string
  readonly endpoint: EndpointConfig
  readonly acceptedAt: EpochMs
}

export type RequestStatus = 'pending' | 'claimed' | 'completed' | 'failed'
export type AttemptStatus = 'due' | 'accepted' | 'rejected' | 'unknown'

export interface FinalResult {
  readonly resultId: string
  readonly text: string
  readonly attachments?: readonly MediaReference[]
  readonly completedAt: EpochMs
}

export interface ProcessingClaim {
  readonly key: string
  readonly token: string
  readonly claimedAt: EpochMs
}

export interface AttemptState {
  readonly status: AttemptStatus
  readonly attempts: number
  readonly dueAt: EpochMs
  readonly errorCode?: string
  readonly lease?: Lease
}

export interface Lease {
  readonly token: string
  readonly version: number
  readonly expiresAt: EpochMs
}

export interface InboundRecord {
  readonly snapshot: InboundSnapshot
  readonly status: RequestStatus
  readonly version: number
  readonly dispatch: AttemptState
  readonly claim?: ProcessingClaim
  readonly result?: FinalResult
  readonly errorCode?: string
  readonly redactedAt?: EpochMs
}

export interface DeliveryChunk {
  readonly text: string
  /** A media chunk has empty text; preceding text chunks preserve the caption. */
  readonly media?: MediaReference
  readonly idempotencyKey: string
  readonly state: Json
}

export interface SendReceipt {
  readonly platformMessageId?: string
  readonly data?: Json
}

export type DeliveryStatus = 'pending' | 'sent' | 'rejected' | 'unknown'

export interface OutboundRecord {
  readonly deliveryId: string
  readonly requestId: string
  readonly resultId: string
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

export interface IngestReceipt {
  readonly requestId: string
  readonly duplicate: boolean
}

export type ClaimResult =
  | {
      readonly status: 'claimed'
      readonly request: InboundSnapshot
      readonly claimToken: string
      readonly replay: boolean
    }
  | { readonly status: 'busy' | 'not_found' | 'not_pending' }

export type CompletionResult =
  | {
      readonly status: 'completed'
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
  | {
      readonly status: 'retryable'
      readonly errorCode: string
      readonly retryAfterMs?: number
    }
  | { readonly status: 'rejected' | 'unknown'; readonly errorCode: string }

export interface SendInput {
  readonly deliveryId: string
  readonly requestId: string
  readonly target: ReplyTarget
  readonly chunk: DeliveryChunk
  readonly chunkIndex: number
  /** Resolved by core from durable storage, bound to this request and chunk. */
  readonly media?: StoredMedia
  /** Preview resolved from the same request by core. */
  readonly preview?: StoredMedia
  readonly signal: AbortSignal
}

export interface DispatchInput {
  readonly request: InboundSnapshot
  readonly signal: AbortSignal
}
