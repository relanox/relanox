import type {
  AgentMessage,
  InboundRecord,
  InboundSnapshot
} from './messages.js'
import type { StoredMedia } from './media.js'
import type { PluginMetadata } from './plugins.js'
import type { Observability } from './observability.js'
import type { Json } from './values.js'

/** Public message content only: no endpoint credentials or private platform reply target. */
export type MiddlewareMessage = Omit<AgentMessage, 'reply'>

/** Captured in configured order at acceptance. Options must contain no credentials. */
export type MiddlewarePlan = { readonly id: string; readonly options: Json }

/** Null filters the whole message; an object transforms text/data, never routing or original media. */
export type MiddlewareOutput = {
  readonly text: string
  readonly data?: Json
} | null

export type MiddlewareResult = { readonly id: string } & (
  | { readonly status: 'completed'; readonly output: MiddlewareOutput }
  | {
      readonly status: 'failed'
      readonly errorCode:
        | 'disabled'
        | 'interrupted'
        | 'timeout'
        | 'middleware_failed'
        | 'invalid_result'
    }
)

export type MessageMiddleware = {
  readonly id: string
  /** Synchronous, offline selection. undefined leaves this message on the ordinary relay path. */
  plan(message: MiddlewareMessage): Json | undefined
  process(input: {
    readonly message: MiddlewareMessage
    readonly options: Json
    readonly signal: AbortSignal
    readonly observe: Observability
    /** Scoped to attachments of this original incoming message. */
    readMedia(this: void, mediaId: string): Promise<StoredMedia | undefined>
  }): Promise<MiddlewareOutput>
}

export type MiddlewarePlugin<C = Json> = {
  readonly kind: 'middleware'
  validateConfig(config: unknown): C
  setup(config: C): Promise<MessageMiddleware>
} & PluginMetadata

/** Durable terminal decision, retained even after preparation outputs are redacted. */
export function isFiltered(record: InboundRecord): boolean {
  return record.dispatch.errorCode === 'middleware_filtered'
}

export function needsPreparation(record: InboundRecord): boolean {
  return (
    Boolean(record.snapshot.middleware?.length) &&
    record.preparation === undefined
  )
}

export function failedPreparation(
  snapshot: InboundSnapshot,
  errorCode: Extract<MiddlewareResult, { status: 'failed' }>['errorCode']
): readonly MiddlewareResult[] {
  return (snapshot.middleware ?? []).map(({ id }) => ({
    id,
    status: 'failed',
    errorCode
  }))
}
