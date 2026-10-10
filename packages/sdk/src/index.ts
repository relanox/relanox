/** All durable times are integer Unix epoch milliseconds. JSON excludes undefined. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export type EpochMs = number;
export const SDK_MAJOR = 1 as const;
export type ChannelId =
  | "telegram"
  | "discord"
  | "slack"
  | "feishu"
  | "wecom"
  | "dingtalk"
  | "qq"
  | "msteams"
  | "whatsapp"
  | "matrix"
  | "googlechat"
  | "line"
  | "mattermost"
  | "signal"
  | "irc";
export type AgentId = "dot" | "grok";
export interface SecretRef {
  readonly env: string;
}
export interface AccountConfig {
  readonly id: string;
  readonly channel: ChannelId;
  readonly config: Json;
  readonly allowedSenders: readonly string[];
}
export interface EndpointConfig {
  readonly id: string;
  readonly agent: AgentId;
  readonly config: Json;
  readonly dispatchMode: "push" | "pull";
}
export interface Binding {
  readonly accountId: string;
  readonly chatId: string;
  readonly threadId?: string;
  readonly endpointId: string;
  readonly allowedSenders?: readonly string[];
}
export interface RelanoxConfig {
  readonly accounts: readonly AccountConfig[];
  readonly endpoints: readonly EndpointConfig[];
  readonly bindings: readonly Binding[];
  readonly storage: {
    readonly plugin: "sqlite" | "postgres";
    readonly config: Json;
  };
  readonly observability: {
    readonly plugin: "standard" | "none";
    readonly config: Json;
  };
}
/** Platform-specific durable address, never a reply closure or ephemeral reply token. */
export interface ReplyTarget {
  readonly channel: ChannelId;
  readonly accountId: string;
  readonly chatId: string;
  readonly threadId?: string;
  readonly replyToId?: string;
  readonly data: Json;
}
export interface SourceKey {
  readonly channel: ChannelId;
  readonly accountId: string;
  readonly eventId: string;
}
export interface TraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}
export interface IngestInput {
  readonly source: SourceKey;
  readonly senderId: string;
  readonly text: string;
  readonly target: ReplyTarget;
  readonly receivedAt: EpochMs;
  readonly context: Json;
  readonly trace?: TraceContext;
}
export interface InboundSnapshot extends IngestInput {
  readonly requestId: string;
  readonly endpoint: EndpointConfig;
  readonly acceptedAt: EpochMs;
}
export type RequestStatus = "pending" | "claimed" | "completed" | "failed";
export type AttemptStatus = "due" | "accepted" | "rejected" | "unknown";
export interface FinalResult {
  readonly resultId: string;
  readonly text: string;
  readonly completedAt: EpochMs;
}
export interface ProcessingClaim {
  readonly key: string;
  readonly token: string;
  readonly claimedAt: EpochMs;
}
export interface AttemptState {
  readonly status: AttemptStatus;
  readonly attempts: number;
  readonly dueAt: EpochMs;
  readonly errorCode?: string;
  readonly lease?: Lease;
}
export interface Lease {
  readonly token: string;
  readonly version: number;
  readonly expiresAt: EpochMs;
}
export interface InboundRecord {
  readonly snapshot: InboundSnapshot;
  readonly status: RequestStatus;
  readonly version: number;
  readonly dispatch: AttemptState;
  readonly claim?: ProcessingClaim;
  readonly result?: FinalResult;
  readonly errorCode?: string;
  readonly redactedAt?: EpochMs;
}
export interface DeliveryChunk {
  readonly text: string;
  readonly idempotencyKey: string;
  readonly state: Json;
}
export interface SendReceipt {
  readonly platformMessageId?: string;
  readonly data?: Json;
}
export type DeliveryStatus = "pending" | "sent" | "rejected" | "unknown";
export interface OutboundRecord {
  readonly deliveryId: string;
  readonly requestId: string;
  readonly resultId: string;
  readonly target: ReplyTarget;
  readonly chunks: readonly DeliveryChunk[];
  readonly currentChunk: number;
  readonly receipts: readonly SendReceipt[];
  readonly status: DeliveryStatus;
  readonly version: number;
  readonly attempts: number;
  readonly dueAt: EpochMs;
  readonly createdAt: EpochMs;
  readonly lease?: Lease;
  readonly errorCode?: string;
  readonly trace?: TraceContext;
}
export interface IngestReceipt {
  readonly requestId: string;
  readonly duplicate: boolean;
}
export type ClaimResult =
  | {
      readonly status: "claimed";
      readonly request: InboundSnapshot;
      readonly claimToken: string;
      readonly replay: boolean;
    }
  | { readonly status: "busy" | "not_found" | "not_pending" };
export type CompletionResult =
  | {
      readonly status: "completed";
      readonly deliveryId: string;
      readonly replay: boolean;
    }
  | { readonly status: "not_found" | "unauthorized" | "conflict" };
export type MutationResult =
  | { readonly status: "updated"; readonly version: number }
  | { readonly status: "not_found" | "conflict" | "unauthorized" };
export type DispatchResult =
  | { readonly status: "accepted" }
  | {
      readonly status: "retryable";
      readonly errorCode: string;
      readonly retryAfterMs?: number;
    }
  | { readonly status: "rejected" | "unknown"; readonly errorCode: string };
export type SendResult =
  | { readonly status: "sent"; readonly receipt: SendReceipt }
  | {
      readonly status: "retryable";
      readonly errorCode: string;
      readonly retryAfterMs?: number;
    }
  | { readonly status: "rejected" | "unknown"; readonly errorCode: string };
export interface SendInput {
  readonly deliveryId: string;
  readonly requestId: string;
  readonly target: ReplyTarget;
  readonly chunk: DeliveryChunk;
  readonly chunkIndex: number;
  readonly signal: AbortSignal;
}
export interface DispatchInput {
  readonly request: InboundSnapshot;
  readonly signal: AbortSignal;
}
export interface StateNamespace {
  readonly pluginId: string;
  readonly ownerId: string;
}
export interface StateEntry {
  readonly key: string;
  readonly value: Json;
  readonly version: number;
  readonly expiresAt?: EpochMs;
}
export interface StateStore {
  get(key: string): Promise<StateEntry | undefined>;
  list(input: {
    readonly prefix?: string;
    readonly expiresBefore?: EpochMs;
    readonly limit: number;
  }): Promise<readonly StateEntry[]>;
  compareAndSet(input: {
    readonly key: string;
    readonly expectedVersion: number | null;
    readonly value: Json;
    readonly expiresAt?: EpochMs;
  }): Promise<MutationResult>;
  delete(key: string, expectedVersion: number): Promise<MutationResult>;
}
export interface StorageStats {
  readonly pending: number;
  readonly claimed: number;
  readonly undelivered: number;
  readonly unknown: number;
  readonly oldestPendingAt?: EpochMs;
}
export interface Health {
  readonly ok: boolean;
  readonly errorCode?: string;
}
export interface ClaimInput {
  readonly requestId: string;
  readonly endpointIds: readonly string[];
  readonly claimKey: string;
  readonly claimToken: string;
  readonly now: EpochMs;
}
export interface CompleteInput {
  readonly requestId: string;
  readonly endpointIds: readonly string[];
  readonly claimToken: string;
  readonly result: FinalResult;
  readonly outbound: OutboundRecord;
}
export interface FailInput {
  readonly requestId: string;
  readonly endpointIds: readonly string[];
  readonly claimToken: string;
  readonly errorCode: string;
  readonly now: EpochMs;
}
export type DueWork =
  | {
      readonly kind: "dispatch";
      readonly record: InboundRecord;
      readonly lease: Lease;
    }
  | {
      readonly kind: "send";
      readonly record: OutboundRecord;
      readonly lease: Lease;
    };
/** Storage atomically acquires leases; expired in-flight work becomes unknown unless its channel has durable idempotency. */
export interface TakeDueInput {
  readonly now: EpochMs;
  readonly leaseMs: number;
  readonly limit: number;
  readonly leaseOwner: string;
  readonly safeRetryAccountIds: readonly string[];
}
export type Settlement =
  | {
      readonly kind: "dispatch";
      readonly id: string;
      readonly lease: Lease;
      readonly outcome: DispatchResult;
      readonly nextDueAt: EpochMs;
      readonly now: EpochMs;
    }
  | {
      readonly kind: "send";
      readonly id: string;
      readonly lease: Lease;
      readonly outcome: SendResult;
      readonly nextDueAt: EpochMs;
      readonly now: EpochMs;
    };
export interface StatusFilter {
  readonly requestStatus?: RequestStatus;
  readonly deliveryStatus?: DeliveryStatus;
  readonly endpointId?: string;
  readonly limit: number;
  readonly afterId?: string;
}
export interface Storage {
  acceptInbound(snapshot: InboundSnapshot): Promise<IngestReceipt>;
  listPending(input: {
    readonly endpointIds: readonly string[];
    readonly limit: number;
  }): Promise<readonly InboundSnapshot[]>;
  claimRequest(input: ClaimInput): Promise<ClaimResult>;
  completeAndEnqueue(input: CompleteInput): Promise<CompletionResult>;
  fail(input: FailInput): Promise<MutationResult>;
  requeue(input: {
    readonly kind: "request" | "delivery";
    readonly id: string;
    readonly expectedVersion: number;
    readonly now: EpochMs;
    readonly acknowledgeUnknown: boolean;
  }): Promise<MutationResult>;
  takeDue(input: TakeDueInput): Promise<readonly DueWork[]>;
  settleAttempt(input: Settlement): Promise<MutationResult>;
  getState(namespace: StateNamespace, key: string): Promise<StateEntry | undefined>;
  listState(
    namespace: StateNamespace,
    input: {
      readonly prefix?: string;
      readonly expiresBefore?: EpochMs;
      readonly limit: number;
    },
  ): Promise<readonly StateEntry[]>;
  compareAndSetState(
    namespace: StateNamespace,
    input: {
      readonly key: string;
      readonly expectedVersion: number | null;
      readonly value: Json;
      readonly expiresAt?: EpochMs;
    },
  ): Promise<MutationResult>;
  deleteState(
    namespace: StateNamespace,
    key: string,
    expectedVersion: number,
  ): Promise<MutationResult>;
  getInbound(requestId: string): Promise<InboundRecord | undefined>;
  getOutbound(deliveryId: string): Promise<OutboundRecord | undefined>;
  listInbound(filter: StatusFilter): Promise<readonly InboundRecord[]>;
  listOutbound(filter: StatusFilter): Promise<readonly OutboundRecord[]>;
  getStats(): Promise<StorageStats>;
  cleanup(input: {
    readonly before: EpochMs;
    readonly limit: number;
  }): Promise<{ readonly redacted: number }>;
  migrate(): Promise<void>;
  health(): Promise<Health>;
  close(): Promise<void>;
}
export type MetricLabels = Readonly<
  Partial<Record<"channel" | "agent" | "plugin" | "operation" | "outcome" | "error_class", string>>
>;
export interface LogFields {
  readonly plugin?: string;
  readonly requestId?: string;
  readonly deliveryId?: string;
  readonly traceId?: string;
  readonly errorCode?: string;
  readonly outcome?: string;
  readonly operation?: string;
}
export interface Span {
  readonly context?: TraceContext;
  end(outcome?: "ok" | "error"): void;
}
export interface Observability {
  log(level: "debug" | "info" | "warn" | "error", event: string, fields?: LogFields): void;
  count(name: string, labels?: MetricLabels, value?: number): void;
  record(name: string, value: number, labels?: MetricLabels): void;
  span(name: string, fields?: LogFields, parent?: TraceContext): Span;
}
export const noopObservability: Observability = Object.freeze({
  log() {},
  count() {},
  record() {},
  span() {
    return { end() {} };
  },
});
export type HttpHandler = (request: Request) => Promise<Response>;
export interface CommonHost {
  readonly observe: Observability;
  readonly state: StateStore;
  mountHttp(path: string, handler: HttpHandler): void;
  connection(status: "connected" | "disconnected" | "degraded", errorCode?: string): void;
}
/** Core binds this host to a single validated account; plugins cannot choose the account scope. */
export interface ChannelHost extends CommonHost {
  ingest(input: IngestInput): Promise<IngestReceipt>;
}
export interface AgentPrincipal {
  readonly subject: string;
  readonly endpointIds: readonly string[];
}
/** Principal comes only from verified protocol authentication. Core intersects it with this plugin's configured endpoints. */
export interface ScopedAgentHost {
  listPending(limit: number): Promise<readonly InboundSnapshot[]>;
  claim(requestId: string, claimKey: string): Promise<ClaimResult>;
  complete(input: {
    readonly requestId: string;
    readonly claimToken: string;
    readonly resultId: string;
    readonly text: string;
  }): Promise<CompletionResult>;
  fail(input: {
    readonly requestId: string;
    readonly claimToken: string;
    readonly errorCode: string;
  }): Promise<MutationResult>;
}
export interface AgentHost extends CommonHost {
  forPrincipal(principal: AgentPrincipal): ScopedAgentHost;
}
export interface PluginMetadata {
  readonly id: string;
  readonly sdkMajor: typeof SDK_MAJOR;
  readonly runtime: "node";
}
export interface Lifecycle {
  start?(signal: AbortSignal): Promise<void>;
  stop?(): Promise<void>;
}
export interface ChannelPlugin<C = Json> extends PluginMetadata, Lifecycle {
  readonly kind: "channel";
  readonly channel: ChannelId;
  readonly capabilities: {
    readonly receive: true;
    readonly transport: "http" | "connection" | "both";
    readonly maxTextLength: number;
    readonly lengthUnit: "utf16" | "codepoint" | "utf8";
    readonly idempotentSend: boolean;
  };
  validateConfig(config: unknown): C;
  setup(host: ChannelHost, account: AccountConfig, config: C): Promise<void>;
  send(input: SendInput): Promise<SendResult>;
}
export interface AgentPlugin<C = Json> extends PluginMetadata, Lifecycle {
  readonly kind: "agent";
  readonly agent: AgentId;
  validateConfig(config: unknown): C;
  setup(host: AgentHost, endpoints: readonly EndpointConfig[], config: C): Promise<void>;
  dispatch(input: DispatchInput): Promise<DispatchResult>;
}
export interface StoragePlugin<C = Json> extends PluginMetadata {
  readonly kind: "storage";
  validateConfig(config: unknown): C;
  setup(config: C, observe: Observability): Promise<Storage>;
}
export interface ObservabilityRuntime {
  readonly observe: Observability;
  readonly metrics?: HttpHandler;
  flush(signal: AbortSignal): Promise<void>;
  shutdown(signal: AbortSignal): Promise<void>;
}
export interface ObservabilityPlugin<C = Json> extends PluginMetadata {
  readonly kind: "observability";
  validateConfig(config: unknown): C;
  setup(config: C): Promise<ObservabilityRuntime>;
}
