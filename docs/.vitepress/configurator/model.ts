import { validatePublicUrl } from '../../../packages/sdk/src/index.js'
import { CHANNELS } from './channels.js'
import type {
  AgentState,
  ChannelState,
  ConfiguratorState,
  FieldDefinition,
  GeneratedConfig,
  Json
} from './types.js'

export function addAgent(state: ConfiguratorState): AgentState {
  const number = state.nextAgentNumber++

  const agent: AgentState = {
    id: `agent-${number}`,
    name: `Agent ${number}`,
    type: 'dot'
  }

  state.agents.push(agent)
  return agent
}

export function removeAgent(state: ConfiguratorState, id: string): void {
  state.agents = state.agents.filter((agent) => agent.id !== id)
  for (const channel of state.channels) {
    if (channel.endpointId === id) {
      channel.endpointId = ''
    }
  }
}

export function createState(): ConfiguratorState {
  const state: ConfiguratorState = {
    publicHost: '',
    agents: [],
    channels: [],
    nextAgentNumber: 1
  }

  const agent = addAgent(state)
  state.channels = CHANNELS.map((channel) => ({
    channel: channel.id,
    enabled: channel.id === 'telegram',
    fields: Object.fromEntries(
      channel.fields.map((field) => [field.key, field.defaultValue])
    ),
    chatId: '',
    senderIds: '',
    threadId: '',
    endpointId: agent.id
  }))
  return state
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
    return 'http://127.0.0.1:8787'
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
    token: { env: `${prefix}_MCP_TOKEN` }
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
        id: `${channel.channel}-main`,
        channel: channel.channel,
        allowedSenders: splitIds(channel.senderIds),
        config: accountConfig(channel)
      })),
      endpoints: state.agents.map((agent) => ({
        id: agent.id,
        agent: agent.type,
        config: endpointConfig(agent)
      })),
      bindings: enabled.map(bindingFor),
      storage: {
        plugin: 'sqlite',
        config: { filename: 'data/relanox.sqlite' }
      }
    }
  }
}

function bindingFor(
  channel: ChannelState
): GeneratedConfig['relay']['bindings'][number] {
  const binding: GeneratedConfig['relay']['bindings'][number] = {
    accountId: `${channel.channel}-main`,
    chatId: channel.chatId.trim(),
    endpointId: channel.endpointId
  }

  if (channel.threadId.trim()) {
    binding.threadId = channel.threadId.trim()
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
  const required = publicHttpsChannels(state).length > 0
  const host = state.publicHost.trim()
  if (!host && required) {
    return [{ code: 'publicHostRequired', target: 'publicHost' }]
  }
  try {
    const origin = validatePublicUrl(publicOrigin(host))
    if (required && !origin.startsWith('https:')) {
      return [{ code: 'publicHostRequired', target: 'publicHost' }]
    }
  } catch {
    return [{ code: 'publicHost', target: 'publicHost' }]
  }
  if (host.includes('relay.example.com')) {
    return [{ code: 'placeholderHost', target: 'publicHost' }]
  }
  return []
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
  const target = channel.channel
  if (!channel.chatId.trim()) {
    issues.push({ code: 'chatId', target })
  }
  if (splitIds(channel.senderIds).length === 0) {
    issues.push({ code: 'senderIds', target })
  }
  if (!state.agents.some((agent) => agent.id === channel.endpointId)) {
    issues.push({ code: 'mapping', target })
  }
  const definition = CHANNELS.find((entry) => entry.id === target)
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

export function webhookDetails(
  state: ConfiguratorState
): { id: string; webhookUrl: string }[] {
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
      id: `${channel.channel}-main`,
      webhookUrl: `${publicOrigin(state.publicHost)}/channels/${channel.channel}-main/${webhookPath(channel.channel)}`
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
): { id: string; mcpUrl: string; tokenEnv: string }[] {
  return state.agents.map((agent) => ({
    id: agent.id,
    mcpUrl: `${publicOrigin(state.publicHost)}/agents/${agent.type}/mcp/${agent.id}`,
    tokenEnv: `RELANOX_${agent.id.replaceAll('-', '_').toUpperCase()}_MCP_TOKEN`
  }))
}
