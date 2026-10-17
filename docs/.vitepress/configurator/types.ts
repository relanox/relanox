export type Locale = 'en' | 'zh'
export type Localized = Record<Locale, string>

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json }

export type AgentType = 'dot' | 'grok' | 'muse'

export type FieldDefinition = {
  key: string
  label: Localized
  kind: 'text' | 'env' | 'list' | 'number' | 'boolean' | 'select'
  defaultValue: string
  placeholder?: string
  requiresInput?: boolean
  options?: string[]
  optional?: boolean
  uiOnly?: boolean
}

export type ChannelDefinition = {
  id: string
  name: Localized
  fields: FieldDefinition[]
  chatExample: string
  senderExample: string
  webhook: boolean
  setup: Localized
}

export type AgentState = {
  id: string
  name: string
  type: AgentType
  mcpToken: string
  endpointId: string
  fields: Record<string, string>
}

export type ChatState = {
  id: string
  chatId: string
  threadId: string
  senderIds?: string
  recipientType?: string
  endpointId: string
}

export type ChannelState = {
  id: string
  channel: string
  enabled: boolean
  accountId: string
  fields: Record<string, string>
  senderIds: string
  chats: ChatState[]
  nextChatNumber: number
}

export type ConfiguratorState = {
  publicHost: string
  storageDriver: string
  storagePath: string
  storageUrl: string
  storageUrlFile: string
  storageSchema: string
  listen: string
  managementListen: string
  agents: AgentState[]
  channels: ChannelState[]
  nextAgentNumber: number
  nextAccountNumber: number
}

export type GeneratedConfig = {
  storage: Record<string, Json>
  http: { listen: string; managementListen: string; publicUrl: string }
  accounts: {
    id: string
    channel: string
    config: Record<string, Json>
    allowedSenders: string[]
  }[]
  endpoints: { id: string; agent: AgentType; config: Record<string, Json> }[]
  bindings: {
    accountId: string
    chatId: string
    endpointId: string
    threadId?: string
    allowedSenders?: string[]
  }[]
}

export type ConnectionDetails = {
  id: string
  mcpUrl: string
  tokenEnv: string
  token: string
  auth: 'oauth' | 'path' | 'bearer'
}
