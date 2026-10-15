import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateApp } from '../../apps/cli/src/runtime.js'
import { openStorage } from '../../apps/cli/src/storage.js'
import { CHANNELS } from '../../docs/.vitepress/configurator/channels.js'
import {
  addAgent,
  addAccount,
  removeAccount,
  addChat,
  removeChat,
  buildConfig,
  connectionDetails,
  createState,
  environmentNames,
  generateMcpToken,
  removeAgent,
  validateDraft,
  webhookDetails
} from '../../docs/.vitepress/configurator/model.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Required fixture entry missing')
  }
  return value
}

function completedState(): ReturnType<typeof createState> {
  const state = createState()
  state.publicHost = 'relay.test.example:8443'
  for (const agent of state.agents) {
    agent.mcpToken = generateMcpToken()
  }
  for (const channel of state.channels) {
    const definition = CHANNELS.find((entry) => entry.id === channel.channel)
    channel.enabled = true
    const chat = channel.chats[0]
    if (!chat) {
      throw new Error('Chat missing')
    }
    chat.chatId = definition?.chatExample ?? ''
    channel.senderIds = definition?.senderExample ?? ''
    for (const field of definition?.fields ?? []) {
      if (field.requiresInput) {
        channel.fields[field.key] = field.placeholder ?? ''
      }
    }
  }
  return state
}

describe('connection configurator production contracts', () => {
  it('starts generated SQLite storage in a fresh launch directory', async () => {
    const launchDirectory = await mkdtemp(
      join(tmpdir(), 'relanox-configurator-')
    )

    const previousDirectory = process.cwd()
    try {
      process.chdir(launchDirectory)
      const config = await validateApp(buildConfig(completedState()))
      const storage = await openStorage(config.relay.storage)
      try {
        await storage.initialize()
        expect(await storage.health()).toEqual({ ok: true })
        expect(
          (await stat(join(launchDirectory, 'relanox.sqlite'))).isFile()
        ).toBe(true)
      } finally {
        await storage.close()
      }
    } finally {
      process.chdir(previousDirectory)
      await rm(launchDirectory, { recursive: true, force: true })
    }
  })

  it('exports the single-tenant Teams token authority independently of the allowed activity tenant', async () => {
    const state = completedState()

    const teams = required(
      state.channels.find((channel) => channel.channel === 'msteams')
    )

    for (const channel of state.channels) {
      channel.enabled = channel === teams
    }
    teams.fields.tenantId = 'allowed-activity-tenant'
    teams.fields.tokenUrl =
      'https://login.microsoftonline.com/application-tenant/oauth2/v2.0/token'

    expect(validateDraft(state)).toEqual([])
    const config = await validateApp(buildConfig(state))
    expect(config.relay.accounts[0]?.config).toMatchObject({
      tenantId: 'allowed-activity-tenant',
      tokenUrl:
        'https://login.microsoftonline.com/application-tenant/oauth2/v2.0/token'
    })

    teams.fields.tokenUrl = ''
    expect(validateDraft(state)).toContainEqual({
      code: 'fieldRequired',
      target: 'msteams-main.tokenUrl'
    })
    teams.fields.tokenUrl =
      'http://login.microsoftonline.com/application-tenant/oauth2/v2.0/token'
    expect(validateDraft(state)).toContainEqual({
      code: 'url',
      target: 'msteams-main.tokenUrl'
    })
    await expect(validateApp(buildConfig(state))).rejects.toThrow()
  })

  it('exports only selected WeCom mode credentials and validates both exports through production', async () => {
    const state = completedState()

    const wecom = required(
      state.channels.find((channel) => channel.channel === 'wecom')
    )

    for (const channel of state.channels) {
      channel.enabled = channel === wecom
    }
    wecom.fields.mode = 'webhook'
    expect(buildConfig(state).relay.accounts[0]?.config).toEqual({
      mode: 'webhook',
      botId: wecom.fields.botId,
      token: { env: 'WECOM_TOKEN' },
      encodingAESKey: { env: 'WECOM_ENCODING_AES_KEY' }
    })
    await expect(validateApp(buildConfig(state))).resolves.toBeDefined()
    expect(webhookDetails(state)).toEqual([
      {
        id: wecom.id,
        channel: 'wecom',
        webhookUrl: `https://relay.test.example:8443/channels/${wecom.id}/webhook`
      }
    ])
    expect(environmentNames(buildConfig(state))).not.toContain(
      'WECOM_BOT_SECRET'
    )
    wecom.fields.mode = 'websocket'
    expect(buildConfig(state).relay.accounts[0]?.config).toEqual({
      mode: 'websocket',
      botId: wecom.fields.botId,
      secret: { env: 'WECOM_BOT_SECRET' }
    })
    await expect(validateApp(buildConfig(state))).resolves.toBeDefined()
    expect(webhookDetails(state)).toEqual([])
    expect(environmentNames(buildConfig(state))).not.toContain('WECOM_TOKEN')
  })

  it('keeps SSR drafts credential-free and uses edited browser passwords in connection instructions only', () => {
    const state = createState()
    expect(state.agents[0]?.mcpToken).toBe('')
    expect(validateDraft(state)).toContainEqual({
      code: 'mcpToken',
      target: 'agent-1'
    })
    const agent = state.agents[0]
    if (!agent) {
      throw new Error('Agent missing')
    }
    agent.mcpToken = generateMcpToken()
    expect(agent.mcpToken).toMatch(/^[a-f0-9]{64}$/u)
    expect(buildConfig(state).publicUrl).toBe('')
    expect(connectionDetails(state)[0]?.mcpUrl).toBe('')
    state.publicHost = 'https://relay.test.example'
    agent.mcpToken = 'edited_password_01234567890123456789'
    agent.type = 'grok'
    expect(connectionDetails(state)[0]).toEqual({
      id: 'agent-1',
      mcpUrl:
        'https://relay.test.example/agents/grok/mcp/agent-1/edited_password_01234567890123456789',
      tokenEnv: 'RELANOX_AGENT_1_MCP_TOKEN',
      token: 'edited_password_01234567890123456789',
      auth: 'path'
    })
    expect(buildConfig(state).relay.endpoints[0]?.config.mcp).toEqual({
      token: { env: 'RELANOX_AGENT_1_MCP_TOKEN' },
      auth: 'path'
    })
    expect(JSON.stringify(buildConfig(state))).not.toContain(agent.mcpToken)
    agent.type = 'dot'
    expect(connectionDetails(state)[0]?.mcpUrl).toBe(
      'https://relay.test.example/agents/dot/mcp/agent-1'
    )
    expect(buildConfig(state).relay.endpoints[0]?.config.mcp).toEqual({
      token: { env: 'RELANOX_AGENT_1_MCP_TOKEN' },
      auth: 'oauth'
    })
    agent.mcpToken = 'invalid/password'
    expect(validateDraft(state)).toContainEqual({
      code: 'mcpToken',
      target: 'agent-1'
    })
  })

  it('requires HTTPS for dot OAuth even with an outbound channel', () => {
    const state = completedState()
    state.publicHost = ''
    for (const channel of state.channels) {
      channel.enabled = channel.channel === 'discord'
    }
    expect(validateDraft(state)).toContainEqual({
      code: 'agentPublicHost',
      target: 'publicHost'
    })
    state.publicHost = 'https://relay.test.example'
    expect(validateDraft(state)).toEqual([])
  })

  it('requires the application ID even after sender and conversation IDs are supplied', async () => {
    const state = createState()
    state.publicHost = 'relay.test.example'

    const slack = state.channels.find((channel) => channel.channel === 'slack')

    if (!slack) {
      throw new Error('Slack missing')
    }

    slack.enabled = true
    slack.senderIds = 'U123ABC'
    required(slack.chats[0]).chatId = 'C123ABC'
    expect(
      buildConfig(state).relay.accounts.find(
        (account) => account.channel === 'slack'
      )?.config.appId
    ).toBe('')
    expect(validateDraft(state)).toContainEqual({
      code: 'fieldRequired',
      target: 'slack-main.appId'
    })
  })

  it.each(['dot', 'grok'] as const)(
    'requires a reachable HTTPS origin for %s even with outbound channels',
    async (agentType) => {
      const state = completedState()
      required(state.agents[0]).type = agentType
      for (const channel of state.channels) {
        channel.enabled = channel.channel === 'discord'
      }
      for (const host of [
        '',
        'http://127.0.0.1:8787',
        'https://localhost',
        'https://127.0.0.1',
        'https://192.168.1.2',
        'https://[::1]'
      ]) {
        state.publicHost = host
        expect(validateDraft(state)).toContainEqual({
          code: 'agentPublicHost',
          target: 'publicHost'
        })
      }
      state.publicHost = 'https://10.relay.test.example'
      expect(validateDraft(state)).toEqual([])
      state.publicHost = 'https://relay.test.example:8443'
      expect(validateDraft(state)).toEqual([])
      expect((await validateApp(buildConfig(state))).publicUrl).toBe(
        'https://relay.test.example:8443'
      )
      expect(webhookDetails(state)).toEqual([])
      required(state.channels[0]).enabled = true
      expect(webhookDetails(state)).toEqual([
        {
          id: 'telegram-main',
          channel: 'telegram',
          webhookUrl:
            'https://relay.test.example:8443/channels/telegram-main/webhook'
        }
      ])
      required(state.channels[0]).enabled = false
      expect(buildConfig(state).publicUrl).toBe(
        'https://relay.test.example:8443'
      )
      state.publicHost = 'http://public.example'
      expect(validateDraft(state)).toContainEqual({
        code: 'publicHost',
        target: 'publicHost'
      })
    }
  )

  it('uses native platform callback paths and excludes outbound connections', () => {
    const state = completedState()
    expect(webhookDetails(state)).toEqual([
      {
        id: 'telegram-main',
        channel: 'telegram',
        webhookUrl:
          'https://relay.test.example:8443/channels/telegram-main/webhook'
      },
      {
        id: 'slack-main',
        channel: 'slack',
        webhookUrl: 'https://relay.test.example:8443/channels/slack-main/events'
      },
      {
        id: 'feishu-main',
        channel: 'feishu',
        webhookUrl:
          'https://relay.test.example:8443/channels/feishu-main/events'
      },
      {
        id: 'msteams-main',
        channel: 'msteams',
        webhookUrl:
          'https://relay.test.example:8443/channels/msteams-main/activities'
      },
      {
        id: 'whatsapp-main',
        channel: 'whatsapp',
        webhookUrl:
          'https://relay.test.example:8443/channels/whatsapp-main/webhook'
      },
      {
        id: 'googlechat-main',
        channel: 'googlechat',
        webhookUrl:
          'https://relay.test.example:8443/channels/googlechat-main/webhook'
      },
      {
        id: 'line-main',
        channel: 'line',
        webhookUrl: 'https://relay.test.example:8443/channels/line-main/webhook'
      }
    ])
  })

  it('generates all fifteen native accounts accepted by the production validator', async () => {
    const state = completedState()
    const grok = addAgent(state)
    grok.type = 'grok'
    grok.mcpToken = generateMcpToken()
    const config = buildConfig(state)
    expect(validateDraft(state)).toEqual([])
    expect((await validateApp(config)).relay.accounts).toHaveLength(15)
    expect(config.relay.endpoints.map((entry) => entry.agent)).toEqual([
      'dot',
      'grok'
    ])
    expect(config.relay.endpoints[0]?.config.mcp).toEqual({
      token: { env: 'RELANOX_AGENT_1_MCP_TOKEN' },
      auth: 'oauth'
    })
    expect(config.relay.endpoints[0]?.config).not.toHaveProperty('callback')
    expect(
      config.relay.accounts.find((entry) => entry.channel === 'googlechat')
        ?.config
    ).not.toHaveProperty('audience')
    expect(config.publicUrl).toBe('https://relay.test.example:8443')
    expect(config).not.toHaveProperty('media')
    expect(config.relay).not.toHaveProperty('observability')
    expect((await validateApp(config)).relay.observability).toEqual({
      plugin: 'standard',
      config: {}
    })
  })

  it('preserves explicit routing and credentials across rename, removal and type changes', async () => {
    const state = completedState()
    const second = addAgent(state)
    second.type = 'grok'

    const telegram = state.channels.find(
      (channel) => channel.channel === 'telegram'
    )

    if (!telegram) {
      throw new Error('Telegram missing')
    }
    required(telegram.chats[0]).endpointId = second.id
    required(telegram.chats[0]).threadId = '42'
    second.name = 'My renamed agent'
    let config = buildConfig(state)
    expect((await validateApp(config)).relay.bindings[0]).toMatchObject({
      accountId: 'telegram-main',
      endpointId: 'agent-2',
      threadId: '42'
    })
    expect(environmentNames(config)).toContain('RELANOX_AGENT_2_ROUTINE_URL')
    second.type = 'dot'
    config = buildConfig(state)
    expect((await validateApp(config)).relay.endpoints[1]?.agent).toBe('dot')
    expect(environmentNames(config)).not.toContain(
      'RELANOX_AGENT_2_ROUTINE_URL'
    )
    expect(connectionDetails(state)[1]).toEqual({
      id: 'agent-2',
      mcpUrl: 'https://relay.test.example:8443/agents/dot/mcp/agent-2',
      tokenEnv: 'RELANOX_AGENT_2_MCP_TOKEN',
      token: '',
      auth: 'oauth'
    })
    removeAgent(state, second.id)
    expect(validateDraft(state)).toContainEqual({
      code: 'mapping',
      target: 'telegram-main.chat-1'
    })
    expect(buildConfig(state).relay.bindings[0]?.endpointId).toBe('')
    expect(addAgent(state).id).toBe('agent-3')
  })

  it('exports independent accounts and exact chat/thread routes without reusing credentials or deleted IDs', async () => {
    const state = completedState()
    for (const channel of state.channels) {
      channel.enabled = channel.channel === 'telegram'
    }
    const telegram = required(state.channels[0])
    const secondAgent = addAgent(state)
    secondAgent.mcpToken = generateMcpToken()
    const chat = addChat(telegram, secondAgent.id)
    chat.chatId = required(telegram.chats[0]).chatId
    chat.threadId = '42'
    const secondAccount = addAccount(state, 'telegram')
    secondAccount.senderIds = '987654321'
    required(secondAccount.chats[0]).chatId = '-100123'
    let config = buildConfig(state)
    expect(validateDraft(state)).toEqual([])
    expect((await validateApp(config)).relay.bindings).toEqual([
      {
        accountId: 'telegram-main',
        chatId: '123456789',
        endpointId: 'agent-1'
      },
      {
        accountId: 'telegram-main',
        chatId: '123456789',
        threadId: '42',
        endpointId: 'agent-2'
      },
      { accountId: 'telegram-2', chatId: '-100123', endpointId: 'agent-1' }
    ])
    expect(config.relay.accounts[1]).toMatchObject({
      id: 'telegram-2',
      allowedSenders: ['987654321'],
      config: {
        botToken: { env: 'TELEGRAM_BOT_TOKEN_2' },
        webhookSecret: { env: 'TELEGRAM_WEBHOOK_SECRET_2' }
      }
    })
    expect(webhookDetails(state)[1]?.webhookUrl).toBe(
      'https://relay.test.example:8443/channels/telegram-2/webhook'
    )
    removeAgent(state, secondAgent.id)
    expect(validateDraft(state)).toContainEqual({
      code: 'mapping',
      target: 'telegram-main.chat-2'
    })
    removeChat(telegram, chat.id)
    removeAccount(state, secondAccount.id)
    config = buildConfig(state)
    expect((await validateApp(config)).relay.bindings).toHaveLength(1)
    expect(environmentNames(config)).not.toContain('TELEGRAM_BOT_TOKEN_2')
    expect(addAccount(state, 'telegram').id).toBe('telegram-3')
    expect(addChat(telegram, 'agent-1').id).toBe('chat-3')
  })

  it('reports duplicate chat/thread pairs before exporting an unrunnable draft', async () => {
    const state = completedState()
    const telegram = required(state.channels[0])
    const duplicate = addChat(telegram, 'agent-1')
    duplicate.chatId = ` ${required(telegram.chats[0]).chatId} `
    expect(validateDraft(state)).toContainEqual({
      code: 'duplicateChat',
      target: 'telegram-main.chat-2'
    })
    await expect(validateApp(buildConfig(state))).rejects.toThrow()
    duplicate.threadId = '42'
    expect(validateDraft(state)).toEqual([])
    expect((await validateApp(buildConfig(state))).relay.bindings).toHaveLength(
      16
    )
  })

  it('keeps unfinished values visible while reporting missing access and unsafe public hosts', () => {
    const state = createState()
    expect(buildConfig(state).relay.bindings[0]?.chatId).toBe('')
    expect(buildConfig(state).relay.accounts[0]?.allowedSenders).toEqual([])
    expect(validateDraft(state)).toContainEqual({
      code: 'chatId',
      target: 'telegram-main.chat-1'
    })
    expect(validateDraft(state)).toContainEqual({
      code: 'senderIds',
      target: 'telegram-main'
    })
    state.publicHost = 'http://relay.example.com/path'
    expect(validateDraft(state)).toContainEqual({
      code: 'publicHost',
      target: 'publicHost'
    })
    const telegram = state.channels[0]
    if (!telegram) {
      throw new Error('Telegram missing')
    }
    telegram.fields.botToken = 'not a valid env name'
    expect(validateDraft(state)).toContainEqual({
      code: 'environmentName',
      target: 'telegram-main.botToken'
    })
  })
})
