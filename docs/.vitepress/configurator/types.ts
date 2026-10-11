export type Locale = 'en' | 'zh'
export type Localized = Record<Locale, string>

export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json }

export type AgentType = 'dot' | 'grok'

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
}

export type ChannelState = {
  channel: string
  enabled: boolean
  fields: Record<string, string>
  chatId: string
  senderIds: string
  threadId: string
  endpointId: string
}

export type ConfiguratorState = {
  publicHost: string
  agents: AgentState[]
  channels: ChannelState[]
  nextAgentNumber: number
}

export type GeneratedConfig = {
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
    observability: {
      plugin: 'standard'
      config: Record<string, Json>
    }
  }
  media: { publicBaseUrl: string }
}
