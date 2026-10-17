export type Locale = 'en' | 'zh'
export type Localized = Record<Locale, string>

export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json }

export type AgentType = 'dot' | 'grok' | 'muse'

export type FieldDefinition = {
  key: string
  label: Localized
  kind: 'text' | 'env' | 'list' | 'number' | 'boolean' | 'select'
  defaultValue: string
  placeholder?: string
  requiresInput?: boolean
  options?: string[]
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
}

export type ChatState = {
  id: string
  chatId: string
  threadId: string
  endpointId: string
}

export type ChannelState = {
  id: string
  channel: string
  enabled: boolean
  fields: Record<string, string>
  senderIds: string
  chats: ChatState[]
  nextChatNumber: number
}

export type ConfiguratorState = {
  publicHost: string
  agents: AgentState[]
  channels: ChannelState[]
  nextAgentNumber: number
  nextAccountNumber: number
}

export type GeneratedConfig = {
  publicUrl: string
  relay: {
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
    }[]
    storage: { plugin: 'sqlite'; config: { filename: string } }
  }
}

export type ConnectionDetails = {
  id: string
  mcpUrl: string
  tokenEnv: string
  token: string
  auth: 'oauth' | 'path'
}
