import type { Json, SDK_MAJOR } from "./values.js";
import type { ChannelId, AgentId, AccountConfig, EndpointConfig } from "./config.js";
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
  DispatchInput,
} from "./messages.js";
import type { StateStore } from "./state.js";
import type { Storage } from "./storage.js";
import type { Observability } from "./observability.js";

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
