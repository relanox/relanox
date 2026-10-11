import type { Json } from "./values.js";

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
