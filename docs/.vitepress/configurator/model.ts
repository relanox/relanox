import { CHANNELS, accountFields, accountUsesWebhook } from './channels.js'
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

function validatePublicUrl(value: string): string {
  const url = new URL(value)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid origin')
  return url.origin
}

export function addAgent(state: ConfiguratorState): AgentState {
  const number = state.nextAgentNumber++

  const agent: AgentState = {
    id: `agent-${number}`,
    name: `Agent ${number}`,
    type: 'dot',
    endpointId: `agent-${number}`,
    mcpToken: `RELANOX_AGENT_${number}_MCP_TOKEN`,
    fields: {
      'mcp.auth': 'bearer',
      'mcp.token.file': '',
      routineUrl: `RELANOX_AGENT_${number}_ROUTINE_URL`,
      routineAuthorization: `RELANOX_AGENT_${number}_ROUTINE_AUTHORIZATION`,
      credentialsDirectory: '',
      vmId: '',
      sessionId: ''
    }
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
    storageDriver: 'sqlite',
    storagePath: 'state/relanox.db',
    storageUrl: 'RELANOX_DATABASE_URL',
    storageUrlFile: '',
    storageSchema: '',
    listen: '127.0.0.1:8787',
    managementListen: '127.0.0.1:8788',
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
    accountId: id,
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
  for (const field of accountFields(channel)) {
    const value = channel.fields[field.key] ?? ''
    if (field.uiOnly) continue
    if (field.kind === 'env') {
      const reference = secretRef(
        value,
        channel.fields[`${field.key}.file`] ?? ''
      )
      if (Object.keys(reference).length || !field.optional)
        assignField(config, field.key, reference)
    } else if (value.trim() || !field.optional)
      assignField(config, field.key, fieldValue(field, value))
  }
  const recipientTypes = Object.fromEntries(
    channel.chats
      .filter((chat) => chat.recipientType)
      .map((chat) => [chat.chatId.trim(), chat.recipientType!])
  )
  if (
    Object.keys(recipientTypes).length &&
    ['wecom', 'dingtalk', 'qq'].includes(channel.channel) &&
    !(channel.channel === 'wecom' && channel.fields.mode === 'webhook')
  )
    config.recipientTypes = recipientTypes
  return config
}

function secretRef(env: string, file: string): Record<string, Json> {
  return {
    ...(env.trim() ? { env: env.trim() } : {}),
    ...(file.trim() ? { file: file.trim() } : {})
  }
}

function endpointConfig(agent: AgentState): Record<string, Json> {
  const mcp = {
    auth: agent.type === 'dot' ? 'oauth' : agent.fields['mcp.auth'] || 'bearer',
    token: secretRef(agent.mcpToken, agent.fields['mcp.token.file'] ?? '')
  }
  if (agent.type === 'grok')
    return {
      mcp,
      routineUrl: secretRef(
        agent.fields.routineUrl ?? '',
        agent.fields['routineUrl.file'] ?? ''
      ),
      routineAuthorization: secretRef(
        agent.fields.routineAuthorization ?? '',
        agent.fields['routineAuthorization.file'] ?? ''
      )
    }
  if (agent.type === 'muse')
    return {
      mcp,
      credentialsDirectory: agent.fields.credentialsDirectory ?? '',
      ...(agent.fields.vmId ? { vmId: agent.fields.vmId } : {}),
      ...(agent.fields.sessionId ? { sessionId: agent.fields.sessionId } : {})
    }
  return { mcp }
}

/** Produce an editable Go configuration draft for the live preview. */
export function buildConfig(state: ConfiguratorState): GeneratedConfig {
  const enabled = state.channels.filter((channel) => channel.enabled)
  return {
    storage:
      state.storageDriver === 'postgres'
        ? {
            driver: 'postgres',
            url: secretRef(state.storageUrl, state.storageUrlFile),
            ...(state.storageSchema ? { schema: state.storageSchema } : {})
          }
        : { driver: 'sqlite', path: state.storagePath },
    http: {
      listen: state.listen,
      managementListen: state.managementListen,
      publicUrl: publicOrigin(state.publicHost)
    },
    accounts: enabled.map((channel) => ({
      id: channel.accountId,
      channel: channel.channel,
      config: accountConfig(channel),
      allowedSenders: splitIds(channel.senderIds)
    })),
    endpoints: state.agents.map((agent) => ({
      id: agent.endpointId,
      agent: agent.type,
      config: endpointConfig(agent)
    })),
    bindings: enabled.flatMap((channel) =>
      channel.chats.map((chat) => ({
        accountId: channel.accountId,
        chatId: chat.chatId.trim(),
        endpointId:
          state.agents.find((agent) => agent.id === chat.endpointId)
            ?.endpointId ?? '',
        ...(chat.threadId.trim() ? { threadId: chat.threadId.trim() } : {}),
        ...(chat.senderIds?.trim()
          ? { allowedSenders: splitIds(chat.senderIds) }
          : {})
      }))
    )
  }
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
  return [...names].sort()
}

export type DraftIssue = { code: string; target: string }

export function validateDraft(state: ConfiguratorState): DraftIssue[] {
  const issues = publicHostIssues(state)
  inspectSecretReferences(buildConfig(state), '', issues)
  if (
    state.storageDriver === 'postgres' &&
    state.storageSchema &&
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(state.storageSchema)
  )
    issues.push({ code: 'schema', target: 'storage.schema' })
  const ids = [
    ...state.agents.map((agent) => agent.endpointId),
    ...state.channels
      .filter((channel) => channel.enabled)
      .map((channel) => channel.accountId)
  ]
  for (const id of ids)
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id))
      issues.push({ code: 'identifier', target: id })
  for (const group of [
    state.agents.map((agent) => agent.endpointId),
    state.channels
      .filter((channel) => channel.enabled)
      .map((channel) => channel.accountId)
  ])
    if (new Set(group).size !== group.length)
      issues.push({ code: 'duplicateId', target: 'configuration' })
  for (const agent of state.agents) {
    for (const key of agent.type === 'grok'
      ? ['routineUrl', 'routineAuthorization']
      : agent.type === 'muse'
        ? ['credentialsDirectory']
        : []) {
      if (!agent.fields[key]?.trim() && !agent.fields[`${key}.file`]?.trim())
        issues.push({ code: 'fieldRequired', target: `${agent.id}.${key}` })
    }
  }
  if (
    (state.storageDriver === 'sqlite' && !state.storagePath.trim()) ||
    (state.storageDriver === 'postgres' &&
      !state.storageUrl.trim() &&
      !state.storageUrlFile.trim())
  )
    issues.push({ code: 'fieldRequired', target: 'storage' })
  if (!state.channels.some((channel) => channel.enabled)) {
    issues.push({ code: 'channelRequired', target: 'channels' })
  }
  if (state.agents.length === 0) {
    issues.push({ code: 'agentRequired', target: 'agents' })
  }
  for (const agent of state.agents) {
    if (!agent.mcpToken.trim() && !agent.fields['mcp.token.file']?.trim()) {
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

/** Check every generated secret reference, including endpoint and database fields. */
function inspectSecretReferences(
  value: unknown,
  path: string,
  issues: DraftIssue[]
): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const target = path ? `${path}.${key}` : key
    if (
      key === 'env' &&
      typeof child === 'string' &&
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(child)
    )
      issues.push({ code: 'environmentName', target })
    if (key === 'file' && typeof child === 'string' && child.includes('\0'))
      issues.push({ code: 'secretFile', target })
    if (typeof child === 'object')
      inspectSecretReferences(child, target, issues)
  }
}

export function publicHttpsChannels(state: ConfiguratorState): typeof CHANNELS {
  return CHANNELS.filter((definition) =>
    state.channels.some(
      (channel) =>
        channel.enabled &&
        channel.channel === definition.id &&
        accountUsesWebhook(channel)
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
  for (const field of accountFields(channel)) {
    const value = channel.fields[field.key] ?? ''
    if (
      !value.trim() &&
      !channel.fields[`${field.key}.file`]?.trim() &&
      !field.optional
    ) {
      issues.push({ code: 'fieldRequired', target: `${target}.${field.key}` })
    } else if (
      field.kind === 'env' &&
      value.trim() !== '' &&
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
    ) {
      issues.push({
        code: 'environmentName',
        target: `${target}.${field.key}`
      })
    }
    const problem = value.trim() ? fieldProblem(field, value) : undefined
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
    if (
      chat.senderIds &&
      splitIds(chat.senderIds).some(
        (id) => !splitIds(channel.senderIds).includes(id)
      )
    )
      issues.push({ code: 'senderSubset', target })
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
    .filter((channel) => channel.enabled && accountUsesWebhook(channel))
    .map((channel) => ({
      id: channel.id,
      channel: channel.channel,
      webhookUrl: `${publicOrigin(state.publicHost)}/channels/${channel.channel}/${channel.accountId}/${webhookPath(channel.channel)}`
    }))
}

function webhookPath(channel: string): string {
  if (channel === 'slack') {
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
  if (field.key === 'port' && Number(value) > 65535) return 'port'
  if (field.key === 'tokenUrl' && !teamsTokenUrl(value)) return 'tokenUrl'
  if (field.options && !field.options.includes(value)) {
    return 'fieldValue'
  }
  if (
    ['homeserver', 'serverUrl', 'serviceUrl', 'tokenUrl'].includes(field.key)
  ) {
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

function teamsTokenUrl(value: string): boolean {
  try {
    return /^\/[^/]+\/oauth2\/v2\.0\/token$/u.test(new URL(value).pathname)
  } catch {
    return false
  }
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
      : `${publicOrigin(state.publicHost)}/agents/${agent.type}/mcp/${agent.endpointId}${agent.type !== 'dot' && agent.fields['mcp.auth'] === 'path' ? '/<token>' : ''}`,
    tokenEnv: agent.mcpToken,
    token: '',
    auth:
      agent.type === 'dot'
        ? 'oauth'
        : agent.fields['mcp.auth'] === 'path'
          ? 'path'
          : 'bearer'
  }))
}
