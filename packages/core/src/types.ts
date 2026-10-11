import type {
  AgentId,
  AgentPlugin,
  ChannelPlugin,
  Storage,
  Observability,
  RelanoxConfig,
  StatusFilter,
  Health,
  MutationResult,
} from "@relanox/sdk";

export interface WorkerOptions {
  readonly batchSize?: number;
  readonly batchDurationMs?: number;
  readonly callTimeoutMs?: number;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly notificationIntervalMs?: number;
  readonly maxTextBytes?: number;
  readonly maxMediaBytes?: number;
  readonly maxTotalMediaBytes?: number;
  readonly maxAttachments?: number;
  readonly maxContextBytes?: number;
  readonly maxHttpBodyBytes?: number;
}
export interface MediaPublisherOptions {
  readonly publicBaseUrl: string;
  readonly urlLifetimeMs?: number;
  readonly allowInsecureLocalhost?: boolean;
}
export interface CoreOptions {
  readonly media?: MediaPublisherOptions;
  readonly config: unknown;
  readonly storage: Storage;
  readonly channels: ReadonlyMap<string, ChannelPlugin<unknown>>;
  readonly agents: ReadonlyMap<AgentId, AgentPlugin<unknown>>;
  readonly observe?: Observability;
  readonly worker?: WorkerOptions;
}
export interface CoreRuntime {
  readonly config: RelanoxConfig;
  fetch(request: Request): Promise<Response>;
  processDue(): Promise<{
    readonly processed: number;
    readonly conflicts: number;
  }>;
  status(filter?: StatusFilter): Promise<{
    readonly stats: Awaited<ReturnType<Storage["getStats"]>>;
    readonly connections: Readonly<Record<string, string>>;
    readonly requests: Awaited<ReturnType<Storage["listInbound"]>>;
    readonly deliveries: Awaited<ReturnType<Storage["listOutbound"]>>;
  }>;
  health(): Promise<Health>;
  readiness(): Promise<Health>;
  cleanup(input: {
    readonly before: number;
    readonly limit: number;
  }): ReturnType<Storage["cleanup"]>;
  requeue(input: {
    readonly kind: "request" | "delivery";
    readonly id: string;
    readonly expectedVersion: number;
    readonly acknowledgeUnknown: boolean;
  }): Promise<MutationResult>;
  setAccepting(accepting: boolean): void;
}
