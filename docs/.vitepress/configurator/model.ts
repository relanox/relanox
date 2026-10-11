import { validatePublicUrl } from '../../../packages/sdk/src/index.js'
import { CHANNELS } from './channels.js'
import type {
  AgentState,
  ChannelState,
  ChatState,
  ConfiguratorState,
  ConnectionDetails,
  FieldDefinition,
  GeneratedConfig,
  Json
} from './types.js'

export function addAgent(state: ConfiguratorState): AgentState {
  const number = state.nextAgentNumber++

  const agent: AgentState = {
    id: `agent-${number}`,
    name: `Agent ${number}`,
    type: 'dot',
    mcpToken: ''
  }

  state.agents.push(agent)
  return agent
}

export function removeAgent(state: ConfiguratorState, id: string): void {
  state.agents = state.agents.filter((agent) => agent.id !== id)
  for (const channel of state.channels) {
    for (const chat of channel.chats) {
      if (chat.endpointId === id) {
        chat.endpointId = ''
      }
    }
  }
}

export function createState(): ConfiguratorState {
  const state: ConfiguratorState = {
    publicHost: '',
    agents: [],
    channels: [],
    nextAgentNumber: 1,
    nextAccountNumber: 2
  }

  const agent = addAgent(state)
  state.channels = CHANNELS.map((channel) =>
    newAccount(channel.id, `${channel.id}-main`, agent.id)
  )

  const telegram = state.channels.find(
    (channel) => channel.channel === 'telegram'
  )

  if (telegram) {
    telegram.enabled = true
  }
  return state
}

function newAccount(
  channelId: string,
  id: string,
  endpointId: string,
  suffix = ''
): ChannelState {
  const definition = CHANNELS.find((channel) => channel.id === channelId)
  if (!definition) {
    throw new Error('Unknown channel')
  }
  return {
    id,
    channel: channelId,
    enabled: false,
    fields: Object.fromEntries(
      definition.fields.map((field) => [
        field.key,
        field.kind === 'env'
          ? `${field.defaultValue}${suffix}`
          : field.defaultValue
      ])
    ),
    senderIds: '',
    chats: [{ id: 'chat-1', chatId: '', threadId: '', endpointId }],
    nextChatNumber: 2
  }
}

export function addAccount(
  state: ConfiguratorState,
  channelId: string
): ChannelState {
  const number = state.nextAccountNumber++

  const account = newAccount(
    channelId,
    `${channelId}-${number}`,
    state.agents[0]?.id ?? '',
    `_${number}`
  )

  account.enabled = true
  state.channels.push(account)
  return account
}

export function removeAccount(state: ConfiguratorState, id: string): void {
  if (id.endsWith('-main')) {
    return
  }
  state.channels = state.channels.filter((channel) => channel.id !== id)
}

export function addChat(channel: ChannelState, endpointId: string): ChatState {
  const chat = {
    id: `chat-${channel.nextChatNumber++}`,
    chatId: '',
    threadId: '',
    endpointId
  }

  channel.chats.push(chat)
  return chat
}

export function removeChat(channel: ChannelState, id: string): void {
  if (channel.chats.length > 1) {
    channel.chats = channel.chats.filter((chat) => chat.id !== id)
  }
}

export function splitIds(value: string): string[] {
  return value
    .split(/[,\n]/u)
    .map((id) => id.trim())
    .filter(Boolean)
}

function publicOrigin(host: string): string {
  const value = host.trim()
  if (!value) {
    return ''
  }
  return value.includes('://') ? value.replace(/\/+$/u, '') : `https://${value}`
}

function fieldValue(field: FieldDefinition, value: string): Json {
  if (field.kind === 'env') {
    return { env: value }
  }
  if (field.kind === 'list') {
    return splitIds(value)
  }
  if (field.kind === 'boolean') {
    return value === 'true'
  }
  if (field.kind === 'number') {
    return value.trim() ? Number(value) : null
  }
  return value
}

function assignField(
  config: Record<string, Json>,
  path: string,
  value: Json
): void {
  const parts = path.split('.')
  const key = parts.pop()
  let target = config
  for (const part of parts) {
    const child = target[part]
    if (
      child === undefined ||
      child === null ||
      typeof child !== 'object' ||
      Array.isArray(child)
    ) {
      target[part] = {}
    }
    target = target[part] as Record<string, Json>
  }
  if (key) {
    target[key] = value
  }
}

function accountConfig(channel: ChannelState): Record<string, Json> {
  const config: Record<string, Json> = {}
  const definition = CHANNELS.find((entry) => entry.id === channel.channel)
  for (const field of definition?.fields ?? []) {
    assignField(
      config,
      field.key,
      fieldValue(field, channel.fields[field.key] ?? '')
    )
  }
  return config
}

function endpointConfig(agent: AgentState): Record<string, Json> {
  const prefix = `RELANOX_${agent.id.replaceAll('-', '_').toUpperCase()}`

  const mcp = {
    token: { env: `${prefix}_MCP_TOKEN` },
    auth: agent.type === 'dot' ? 'oauth' : 'path'
  }

  if (agent.type === 'grok') {
    return {
      mcp,
      routineUrl: { env: `${prefix}_ROUTINE_URL` },
      routineAuthorization: { env: `${prefix}_ROUTINE_AUTHORIZATION` }
    }
  }
  return { mcp }
}

/** Produce an editable draft, including incomplete fields, for the live preview. */
export function buildConfig(state: ConfiguratorState): GeneratedConfig {
  const enabled = state.channels.filter((channel) => channel.enabled)
  return {
    publicUrl: publicOrigin(state.publicHost),
    relay: {
      accounts: enabled.map((channel) => ({
        id: channel.id,
        channel: channel.channel,
        allowedSenders: splitIds(channel.senderIds),
        config: accountConfig(channel)
      })),
      endpoints: state.agents.map((agent) => ({
        id: agent.id,
        agent: agent.type,
        config: endpointConfig(agent)
      })),
      bindings: enabled.flatMap((channel) =>
        channel.chats.map((chat) => bindingFor(channel, chat))
      ),
      storage: {
        plugin: 'sqlite',
        config: { filename: 'data/relanox.sqlite' }
      }
    }
  }
}

function bindingFor(
  channel: ChannelState,
  chat: ChatState
): GeneratedConfig['relay']['bindings'][number] {
  const binding: GeneratedConfig['relay']['bindings'][number] = {
    accountId: channel.id,
    chatId: chat.chatId.trim(),
    endpointId: chat.endpointId
  }

  if (chat.threadId.trim()) {
    binding.threadId = chat.threadId.trim()
  }
  return binding
}

export function environmentNames(config: GeneratedConfig): string[] {
  const names = new Set<string>()

  function visit(value: unknown): void {
    if (value === null || typeof value !== 'object') {
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'env' && typeof child === 'string') {
        names.add(child)
      } else {
        visit(child)
      }
    }
  }

  visit(config)
  return [...names].toSorted()
}

export type DraftIssue = { code: string; target: string }

export function validateDraft(state: ConfiguratorState): DraftIssue[] {
  const issues = publicHostIssues(state)
  if (!state.channels.some((channel) => channel.enabled)) {
    issues.push({ code: 'channelRequired', target: 'channels' })
  }
  if (state.agents.length === 0) {
    issues.push({ code: 'agentRequired', target: 'agents' })
  }
  for (const agent of state.agents) {
    if (!/^[A-Za-z0-9_-]{32,}$/u.test(agent.mcpToken)) {
      issues.push({ code: 'mcpToken', target: agent.id })
    }
    if (!agent.name.trim()) {
      issues.push({ code: 'agentName', target: agent.id })
    }
  }
  for (const channel of state.channels.filter((entry) => entry.enabled)) {
    issues.push(...channelIssues(channel, state))
  }
  return issues
}

export function publicHttpsChannels(state: ConfiguratorState): typeof CHANNELS {
  return CHANNELS.filter(
    (definition) =>
      definition.webhook &&
      state.channels.some(
        (channel) => channel.enabled && channel.channel === definition.id
      )
  )
}

function publicHostIssues(state: ConfiguratorState): DraftIssue[] {
  const required =
    state.agents.length > 0 || publicHttpsChannels(state).length > 0

  const host = state.publicHost.trim()
  if (!host && required) {
    return [{ code: 'agentPublicHost', target: 'publicHost' }]
  }
  try {
    const origin = validatePublicUrl(publicOrigin(host))
    if (
      required &&
      (!origin.startsWith('https:') || isLocalHost(new URL(origin).hostname))
    ) {
      return [
        {
          code: 'agentPublicHost',
          target: 'publicHost'
        }
      ]
    }
  } catch {
    return [{ code: 'publicHost', target: 'publicHost' }]
  }
  if (host.includes('relay.example.com')) {
    return [{ code: 'placeholderHost', target: 'publicHost' }]
  }
  return []
}

function isLocalHost(host: string): boolean {
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host)

  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '[::]' ||
    host === '0.0.0.0' ||
    (ipv4 &&
      (host.startsWith('127.') ||
        host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        /^172\.(?:1[6-9]|2[0-9]|3[01])\./u.test(host))) ||
    host.endsWith('.local')
  )
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value
  } catch {
    return false
  }
}

function channelIssues(
  channel: ChannelState,
  state: ConfiguratorState
): DraftIssue[] {
  const issues: DraftIssue[] = []
  const target = channel.id
  issues.push(...chatIssues(channel, state))
  if (splitIds(channel.senderIds).length === 0) {
    issues.push({ code: 'senderIds', target })
  }
  const definition = CHANNELS.find((entry) => entry.id === channel.channel)
  for (const field of definition?.fields ?? []) {
    const value = channel.fields[field.key] ?? ''
    if (!value.trim()) {
      issues.push({ code: 'fieldRequired', target: `${target}.${field.key}` })
    } else if (
      field.kind === 'env' &&
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
    ) {
      issues.push({ code: 'environmentName', target: `${target}.${field.key}` })
    }
    const problem = fieldProblem(field, value)
    if (problem) {
      issues.push({ code: problem, target: `${target}.${field.key}` })
    }
  }
  return issues
}

function chatIssues(
  channel: ChannelState,
  state: ConfiguratorState
): DraftIssue[] {
  const issues: DraftIssue[] = []
  const seen = new Set<string>()
  for (const chat of channel.chats) {
    const target = `${channel.id}.${chat.id}`
    if (!chat.chatId.trim()) {
      issues.push({ code: 'chatId', target })
    }
    if (!state.agents.some((agent) => agent.id === chat.endpointId)) {
      issues.push({ code: 'mapping', target })
    }
    const key = JSON.stringify([chat.chatId.trim(), chat.threadId.trim()])
    if (chat.chatId.trim() && seen.has(key)) {
      issues.push({ code: 'duplicateChat', target })
    }
    seen.add(key)
  }
  return issues
}

export function webhookDetails(
  state: ConfiguratorState
): { id: string; channel: string; webhookUrl: string }[] {
  return state.channels
    .filter(
      (channel) =>
        channel.enabled &&
        CHANNELS.some(
          (definition) =>
            definition.id === channel.channel && definition.webhook
        )
    )
    .map((channel) => ({
      id: channel.id,
      channel: channel.channel,
      webhookUrl: `${publicOrigin(state.publicHost)}/channels/${channel.id}/${webhookPath(channel.channel)}`
    }))
}

function webhookPath(channel: string): string {
  if (channel === 'slack' || channel === 'feishu') {
    return 'events'
  }
  if (channel === 'msteams') {
    return 'activities'
  }
  return 'webhook'
}

function fieldProblem(
  field: FieldDefinition,
  value: string
): string | undefined {
  if (
    field.kind === 'number' &&
    (!Number.isInteger(Number(value)) || Number(value) < 0)
  ) {
    return 'number'
  }
  if (field.options && !field.options.includes(value)) {
    return 'fieldValue'
  }
  if (['homeserver', 'serverUrl', 'serviceUrl'].includes(field.key)) {
    return secureUrlProblem(value)
  }
  if (
    field.key === 'trustedServiceOrigins' &&
    splitIds(value).some((origin) => !validOrigin(origin))
  ) {
    return 'origin'
  }
  return undefined
}

function secureUrlProblem(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return 'url'
    }
    return undefined
  } catch {
    return 'url'
  }
}

export function connectionDetails(
  state: ConfiguratorState
): ConnectionDetails[] {
  return state.agents.map((agent) => ({
    id: agent.id,
    mcpUrl: !state.publicHost.trim()
      ? ''
      : `${publicOrigin(state.publicHost)}/agents/${agent.type}/mcp/${agent.id}${agent.type === 'grok' && agent.mcpToken ? `/${encodeURIComponent(agent.mcpToken)}` : ''}`,
    tokenEnv: `RELANOX_${agent.id.replaceAll('-', '_').toUpperCase()}_MCP_TOKEN`,
    token: agent.mcpToken,
    auth: agent.type === 'dot' ? 'oauth' : 'path'
  }))
}

/** Generate credentials only when explicitly requested by the browser UI. */
export function generateMcpToken(): string {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
