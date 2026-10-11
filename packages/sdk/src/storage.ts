import type { Json, EpochMs } from './values.js'
import type { AgentId } from './config.js'
import type {
  InboundSnapshot,
  RequestStatus,
  FinalResult,
  Lease,
  InboundRecord,
  DeliveryStatus,
  OutboundRecord,
  IngestReceipt,
  ClaimResult,
  CompletionResult,
  MutationResult,
  DispatchResult,
  SendResult
} from './messages.js'
import type { StateNamespace, StateEntry } from './state.js'
import type { MediaStorage, StoredMedia } from './media.js'

export interface StorageStats {
  readonly pending: number
  readonly claimed: number
  readonly undelivered: number
  readonly unknown: number
  readonly oldestPendingAt?: EpochMs
}

export interface Health {
  readonly ok: boolean
  readonly errorCode?: string
}

export interface ClaimInput {
  readonly requestId: string
  readonly endpointIds: readonly string[]
  readonly agent: AgentId
  readonly claimKey: string
  readonly claimToken: string
  readonly now: EpochMs
}

export interface CompleteInput {
  readonly requestId: string
  readonly endpointIds: readonly string[]
  readonly agent: AgentId
  readonly claimToken: string
  readonly result: FinalResult
  readonly outbound: OutboundRecord
}

export interface FailInput {
  readonly requestId: string
  readonly endpointIds: readonly string[]
  readonly agent: AgentId
  readonly claimToken: string
  readonly errorCode: string
  readonly now: EpochMs
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
export interface TakeDueInput {
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

export interface StatusFilter {
  readonly requestStatus?: RequestStatus
  readonly deliveryStatus?: DeliveryStatus
  readonly endpointId?: string
  readonly limit: number
  readonly afterId?: string
}

export interface Storage {
  readonly media?: MediaStorage
  /** Snapshot and all incoming bytes are committed atomically; duplicate input adds no assets. */
  acceptInbound(
    snapshot: InboundSnapshot,
    media?: readonly StoredMedia[]
  ): Promise<IngestReceipt>
  listPending(input: {
    readonly endpointIds: readonly string[]
    readonly agent: AgentId
    readonly limit: number
  }): Promise<readonly InboundSnapshot[]>
  claimRequest(input: ClaimInput): Promise<ClaimResult>
  completeAndEnqueue(input: CompleteInput): Promise<CompletionResult>
  fail(input: FailInput): Promise<MutationResult>
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
  listInbound(filter: StatusFilter): Promise<readonly InboundRecord[]>
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
