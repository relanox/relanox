import type { Json, EpochMs } from './values.js'
import type { AgentId } from './config.js'
import type {
  InboundSnapshot,
  AttemptStatus,
  OutboundMessage,
  Lease,
  InboundRecord,
  DeliveryStatus,
  OutboundRecord,
  IngestReceipt,
  MessageReceipt,
  MutationResult,
  DispatchResult,
  SendResult,
  MessageCursor
} from './messages.js'
import type { StateNamespace, StateEntry } from './state.js'
import type { ConversationStorage } from './conversations.js'
import type { MediaStorage, StoredMedia } from './media.js'

export type StorageStats = {
  readonly pending: number
  readonly undelivered: number
  readonly unknown: number
  readonly oldestPendingAt?: EpochMs
}

export type Health = {
  readonly ok: boolean
  readonly errorCode?: string
}

export type EnqueueMessageInput = {
  readonly channelId: string
  readonly endpointIds: readonly string[]
  readonly agent: AgentId
  readonly message: OutboundMessage
  readonly outbound: OutboundRecord
  readonly media?: readonly StoredMedia[]
  readonly maxCount?: number
  readonly maxTotalBytes?: number
}

export type DueWork =
  | {
      readonly kind: 'dispatch'
      readonly record: InboundRecord
      readonly lease: Lease
    }
  | {
      readonly kind: 'send'
      readonly record: OutboundRecord
      readonly lease: Lease
    }

/** Storage atomically acquires leases; expired in-flight work becomes unknown unless its channel has durable idempotency. */
export type TakeDueInput = {
  readonly now: EpochMs
  readonly leaseMs: number
  readonly limit: number
  readonly leaseOwner: string
  readonly safeRetryAccountIds: readonly string[]
}

export type Settlement =
  | {
      readonly kind: 'dispatch'
      readonly id: string
      readonly lease: Lease
      readonly outcome: DispatchResult
      readonly nextDueAt: EpochMs
      readonly now: EpochMs
    }
  | {
      readonly kind: 'send'
      readonly id: string
      readonly lease: Lease
      readonly outcome: SendResult
      readonly nextDueAt: EpochMs
      readonly now: EpochMs
    }

export type StatusFilter = {
  readonly dispatchStatus?: AttemptStatus
  readonly deliveryStatus?: DeliveryStatus
  readonly endpointId?: string
  readonly limit: number
  readonly afterId?: string
}

export type Storage = ConversationStorage & {
  readonly media?: MediaStorage
  /** Snapshot and all incoming bytes are committed atomically; duplicate input adds no assets. */
  acceptInbound(
    snapshot: InboundSnapshot,
    media?: readonly StoredMedia[]
  ): Promise<IngestReceipt>
  /** Recover an accepted keyed send before selecting a new native capability. */
  getMessageReceipt(
    input: Pick<
      EnqueueMessageInput,
      'channelId' | 'endpointIds' | 'agent' | 'message'
    >
  ): Promise<MessageReceipt>
  enqueueMessage(input: EnqueueMessageInput): Promise<MessageReceipt>
  requeue(input: {
    readonly kind: 'request' | 'delivery'
    readonly id: string
    readonly expectedVersion: number
    readonly now: EpochMs
    readonly acknowledgeUnknown: boolean
  }): Promise<MutationResult>
  takeDue(input: TakeDueInput): Promise<readonly DueWork[]>
  settleAttempt(input: Settlement): Promise<MutationResult>
  getState(
    namespace: StateNamespace,
    key: string
  ): Promise<StateEntry | undefined>
  listState(
    namespace: StateNamespace,
    input: {
      readonly prefix?: string
      readonly expiresBefore?: EpochMs
      readonly limit: number
    }
  ): Promise<readonly StateEntry[]>
  compareAndSetState(
    namespace: StateNamespace,
    input: {
      readonly key: string
      readonly expectedVersion: number | null
      readonly value: Json
      readonly expiresAt?: EpochMs
    }
  ): Promise<MutationResult>
  deleteState(
    namespace: StateNamespace,
    key: string,
    expectedVersion: number
  ): Promise<MutationResult>
  getInbound(requestId: string): Promise<InboundRecord | undefined>
  getOutbound(deliveryId: string): Promise<OutboundRecord | undefined>
  listInbound(
    filter: StatusFilter & {
      /** Latest accepted first; incompatible with afterId. */
      readonly recent?: boolean
    }
  ): Promise<readonly InboundRecord[]>
  /** Tracked, retained inputs without a fully sent final, oldest first within current active channels. */
  listPendingInbound(input: {
    readonly channelIds: readonly string[]
    readonly endpointIds: readonly string[]
    readonly limit: number
    readonly cursor?: MessageCursor
  }): Promise<readonly InboundRecord[]>
  listOutbound(filter: StatusFilter): Promise<readonly OutboundRecord[]>
  getStats(): Promise<StorageStats>
  cleanup(input: {
    readonly before: EpochMs
    readonly limit: number
  }): Promise<{ readonly redacted: number }>
  initialize(): Promise<void>
  health(): Promise<Health>
  close(): Promise<void>
}
