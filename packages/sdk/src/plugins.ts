import type { Json, SDK_MAJOR } from './values.js'
import type {
  ChannelId,
  AgentId,
  AccountConfig,
  EndpointConfig
} from './config.js'
import type {
  IngestInput,
  InboundSnapshot,
  IngestReceipt,
  ClaimResult,
  CompletionResult,
  MutationResult,
  DispatchResult,
  SendResult,
  SendInput,
  DispatchInput
} from './messages.js'
import type { StateStore } from './state.js'
import type { Storage } from './storage.js'
import type { Observability } from './observability.js'
import type { AgentMediaHost, ChannelMediaHost, MediaKind } from './media.js'

export type HttpHandler = (request: Request) => Promise<Response>

export type HttpRouteOptions = {
  readonly maxBodyBytes: number
  /** Reject unauthorized transfers before core reads a potentially large binary body. */
  authorize(request: Request): Promise<Response | undefined>
}

export type CommonHost = {
  readonly observe: Observability
  readonly state: StateStore
  mountHttp(
    path: string,
    handler: HttpHandler,
    options?: HttpRouteOptions
  ): void
  connection(
    status: 'connected' | 'disconnected' | 'degraded',
    errorCode?: string
  ): void
}

/** Core binds this host to a single validated account; plugins cannot choose the account scope. */
export type ChannelHost = {
  readonly maxMediaBytes?: number
  readonly media?: ChannelMediaHost
  ingest(input: IngestInput): Promise<IngestReceipt>
} & CommonHost

export type AgentPrincipal = {
  readonly subject: string
  readonly endpointIds: readonly string[]
}

/** Principal comes only from verified protocol authentication. Core intersects it with this plugin's configured endpoints. */
export type ScopedAgentHost = {
  readonly media?: AgentMediaHost
  listPending(limit: number): Promise<readonly InboundSnapshot[]>
  claim(requestId: string, claimKey: string): Promise<ClaimResult>
  complete(input: {
    readonly requestId: string
    readonly claimToken: string
    readonly resultId: string
    readonly text: string
    /** Ordered IDs of uploaded or inbound media owned by this request. */
    readonly attachments?: readonly string[]
  }): Promise<CompletionResult>
  fail(input: {
    readonly requestId: string
    readonly claimToken: string
    readonly errorCode: string
  }): Promise<MutationResult>
}

export type AgentHost = {
  forPrincipal(principal: AgentPrincipal): ScopedAgentHost
} & CommonHost

export type PluginMetadata = {
  readonly id: string
  readonly sdkMajor: typeof SDK_MAJOR
  readonly runtime: 'node'
}

export type Lifecycle = {
  start?(signal: AbortSignal): Promise<void>
  stop?(): Promise<void>
}

export type ChannelPlugin<C = Json> = {
  readonly kind: 'channel'
  readonly channel: ChannelId
  readonly capabilities: {
    readonly receive: true
    readonly transport: 'http' | 'connection' | 'both'
    readonly maxTextLength: number
    readonly lengthUnit: 'utf16' | 'codepoint' | 'utf8'
    readonly idempotentSend: boolean
    readonly media?: {
      readonly receive: readonly MediaKind[]
      readonly send: readonly MediaKind[]
    }
  }
  validateConfig(config: unknown): C
  setup(host: ChannelHost, account: AccountConfig, config: C): Promise<void>
  send(input: SendInput): Promise<SendResult>
} & PluginMetadata &
  Lifecycle

export type AgentPlugin<C = Json> = {
  readonly kind: 'agent'
  readonly agent: AgentId
  validateConfig(config: unknown): C
  setup(
    host: AgentHost,
    endpoints: readonly EndpointConfig[],
    config: C
  ): Promise<void>
  dispatch(input: DispatchInput): Promise<DispatchResult>
} & PluginMetadata &
  Lifecycle

export type StoragePlugin<C = Json> = {
  readonly kind: 'storage'
  validateConfig(config: unknown): C
  setup(config: C, observe: Observability): Promise<Storage>
} & PluginMetadata

export type ObservabilityRuntime = {
  readonly observe: Observability
  readonly metrics?: HttpHandler
  flush(signal: AbortSignal): Promise<void>
  shutdown(signal: AbortSignal): Promise<void>
}

export type ObservabilityPlugin<C = Json> = {
  readonly kind: 'observability'
  validateConfig(config: unknown): C
  setup(config: C): Promise<ObservabilityRuntime>
} & PluginMetadata
