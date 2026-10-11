import type {
  AgentId,
  AgentPlugin,
  ChannelPlugin,
  Storage,
  Observability,
  RelanoxConfig,
  StatusFilter,
  Health,
  MutationResult
} from '@relanox/sdk'

export type WorkerOptions = {
  readonly maxMediaBytes?: number
  readonly maxTotalMediaBytes?: number
  readonly maxAttachments?: number
}

export type MediaPublisherOptions = {
  readonly urlLifetimeMs?: number
}

export type CoreOptions = {
  readonly publicUrl?: string
  readonly media?: MediaPublisherOptions
  readonly config: unknown
  readonly storage: Storage
  readonly channels: ReadonlyMap<string, ChannelPlugin<unknown>>
  readonly agents: ReadonlyMap<AgentId, AgentPlugin<unknown>>
  readonly observe?: Observability
  readonly worker?: WorkerOptions
}

export type CoreRuntime = {
  readonly config: RelanoxConfig
  fetch(request: Request): Promise<Response>
  processDue(): Promise<{
    readonly processed: number
    readonly conflicts: number
  }>
  status(filter?: StatusFilter): Promise<{
    readonly stats: Awaited<ReturnType<Storage['getStats']>>
    readonly connections: Readonly<Record<string, string>>
    readonly requests: Awaited<ReturnType<Storage['listInbound']>>
    readonly deliveries: Awaited<ReturnType<Storage['listOutbound']>>
  }>
  health(): Promise<Health>
  readiness(): Promise<Health>
  cleanup(input: {
    readonly before: number
    readonly limit: number
  }): ReturnType<Storage['cleanup']>
  requeue(input: {
    readonly kind: 'request' | 'delivery'
    readonly id: string
    readonly expectedVersion: number
    readonly acknowledgeUnknown: boolean
  }): Promise<MutationResult>
  setAccepting(accepting: boolean): void
}
