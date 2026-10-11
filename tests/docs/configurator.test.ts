import { describe, expect, it } from 'vitest'
import { validateApp } from '../../apps/cli/src/runtime.js'
import { CHANNELS } from '../../docs/.vitepress/configurator/channels.js'
import {
  addAgent,
  buildConfig,
  connectionDetails,
  createState,
  environmentNames,
  removeAgent,
  validateDraft,
  webhookDetails
} from '../../docs/.vitepress/configurator/model.js'

function completedState(): ReturnType<typeof createState> {
  const state = createState()
  state.publicHost = 'relay.test.example:8443'
  for (const channel of state.channels) {
    const definition = CHANNELS.find((entry) => entry.id === channel.channel)
    channel.enabled = true
    channel.chatId = definition?.chatExample ?? ''
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
  it('requires the application ID even after sender and conversation IDs are supplied', () => {
    const state = createState()
    state.publicHost = 'relay.test.example'

    const slack = state.channels.find((channel) => channel.channel === 'slack')

    if (!slack) {
      throw new Error('Slack missing')
    }

    slack.enabled = true
    slack.senderIds = 'U123ABC'
    slack.chatId = 'C123ABC'
    expect(
      buildConfig(state).relay.accounts.find(
        (account) => account.channel === 'slack'
      )?.config.appId
    ).toBe('')
    expect(validateDraft(state)).toContainEqual({
      code: 'fieldRequired',
      target: 'slack.appId'
    })
  })

  it.each([
    ['telegram', true],
    ['slack', true],
    ['feishu', true],
    ['msteams', true],
    ['whatsapp', true],
    ['googlechat', true],
    ['line', true],
    ['discord', false],
    ['wecom', false],
    ['dingtalk', false],
    ['qq', false],
    ['matrix', false],
    ['mattermost', false],
    ['signal', false],
    ['irc', false]
  ] as const)(
    'applies %s address requirements without forcing HTTPS on outbound channels',
    (channelId, requiresHttps) => {
      const state = completedState()
      state.publicHost = ''
      for (const channel of state.channels) {
        channel.enabled = channel.channel === channelId
      }
      if (requiresHttps) {
        expect(validateDraft(state)).toContainEqual({
          code: 'publicHostRequired',
          target: 'publicHost'
        })
      } else {
        expect(validateDraft(state)).toEqual([])
        const config = buildConfig(state)
        expect(validateApp(config).publicUrl).toBe('http://127.0.0.1:8787')
        expect(connectionDetails(state)[0]?.mcpUrl).toBe(
          'http://127.0.0.1:8787/agents/dot/mcp/agent-1'
        )
        expect(webhookDetails(state)).toEqual([])
      }
    }
  )

  it('rechecks callback requirements when adding a channel and retains the supplied address', () => {
    const state = completedState()
    for (const channel of state.channels) {
      channel.enabled = channel.channel === 'discord'
    }
    state.publicHost = 'http://[::1]:8787'
    expect(validateDraft(state)).toEqual([])
    expect(validateApp(buildConfig(state)).publicUrl).toBe('http://[::1]:8787')

    const telegram = state.channels.find(
      (channel) => channel.channel === 'telegram'
    )

    if (!telegram) {
      throw new Error('Telegram missing')
    }
    telegram.enabled = true
    expect(validateDraft(state)).toContainEqual({
      code: 'publicHostRequired',
      target: 'publicHost'
    })
    state.publicHost = 'https://relay.test.example:8443'
    expect(validateDraft(state)).toEqual([])
    expect(webhookDetails(state)).toEqual([
      {
        id: 'telegram-main',
        webhookUrl:
          'https://relay.test.example:8443/channels/telegram-main/webhook'
      }
    ])
    telegram.enabled = false
    expect(buildConfig(state).publicUrl).toBe('https://relay.test.example:8443')
    state.publicHost = 'http://public.example'
    expect(validateDraft(state)).toContainEqual({
      code: 'publicHost',
      target: 'publicHost'
    })
  })

  it('uses native platform callback paths and excludes outbound connections', () => {
    const state = completedState()
    expect(webhookDetails(state)).toEqual([
      {
        id: 'telegram-main',
        webhookUrl:
          'https://relay.test.example:8443/channels/telegram-main/webhook'
      },
      {
        id: 'slack-main',
        webhookUrl: 'https://relay.test.example:8443/channels/slack-main/events'
      },
      {
        id: 'feishu-main',
        webhookUrl:
          'https://relay.test.example:8443/channels/feishu-main/events'
      },
      {
        id: 'msteams-main',
        webhookUrl:
          'https://relay.test.example:8443/channels/msteams-main/activities'
      },
      {
        id: 'whatsapp-main',
        webhookUrl:
          'https://relay.test.example:8443/channels/whatsapp-main/webhook'
      },
      {
        id: 'googlechat-main',
        webhookUrl:
          'https://relay.test.example:8443/channels/googlechat-main/webhook'
      },
      {
        id: 'line-main',
        webhookUrl: 'https://relay.test.example:8443/channels/line-main/webhook'
      }
    ])
  })

  it('generates all fifteen native accounts accepted by the production validator', () => {
    const state = completedState()
    addAgent(state).type = 'grok'
    const config = buildConfig(state)
    expect(validateDraft(state)).toEqual([])
    expect(validateApp(config).relay.accounts).toHaveLength(15)
    expect(config.relay.endpoints.map((entry) => entry.agent)).toEqual([
      'dot',
      'grok'
    ])
    expect(config.relay.endpoints[0]?.config.mcp).toEqual({
      token: { env: 'RELANOX_AGENT_1_MCP_TOKEN' }
    })
    expect(config.relay.endpoints[0]?.config).not.toHaveProperty('callback')
    expect(
      config.relay.accounts.find((entry) => entry.channel === 'googlechat')
        ?.config
    ).not.toHaveProperty('audience')
    expect(config.publicUrl).toBe('https://relay.test.example:8443')
    expect(config).not.toHaveProperty('media')
    expect(config.relay).not.toHaveProperty('observability')
    expect(validateApp(config).relay.observability).toEqual({
      plugin: 'standard',
      config: {}
    })
  })

  it('preserves explicit routing and credentials across rename, removal and type changes', () => {
    const state = completedState()
    const second = addAgent(state)
    second.type = 'grok'

    const telegram = state.channels.find(
      (channel) => channel.channel === 'telegram'
    )

    if (!telegram) {
      throw new Error('Telegram missing')
    }
    telegram.endpointId = second.id
    telegram.threadId = '42'
    second.name = 'My renamed agent'
    let config = buildConfig(state)
    expect(validateApp(config).relay.bindings[0]).toMatchObject({
      accountId: 'telegram-main',
      endpointId: 'agent-2',
      threadId: '42'
    })
    expect(environmentNames(config)).toContain('RELANOX_AGENT_2_ROUTINE_URL')
    second.type = 'dot'
    config = buildConfig(state)
    expect(validateApp(config).relay.endpoints[1]?.agent).toBe('dot')
    expect(environmentNames(config)).not.toContain(
      'RELANOX_AGENT_2_ROUTINE_URL'
    )
    expect(connectionDetails(state)[1]).toEqual({
      id: 'agent-2',
      mcpUrl: 'https://relay.test.example:8443/agents/dot/mcp/agent-2',
      tokenEnv: 'RELANOX_AGENT_2_MCP_TOKEN'
    })
    removeAgent(state, second.id)
    expect(validateDraft(state)).toContainEqual({
      code: 'mapping',
      target: 'telegram'
    })
    expect(buildConfig(state).relay.bindings[0]?.endpointId).toBe('')
    expect(addAgent(state).id).toBe('agent-3')
  })

  it('keeps unfinished values visible while reporting missing access and unsafe public hosts', () => {
    const state = createState()
    expect(buildConfig(state).relay.bindings[0]?.chatId).toBe('')
    expect(buildConfig(state).relay.accounts[0]?.allowedSenders).toEqual([])
    expect(validateDraft(state)).toContainEqual({
      code: 'chatId',
      target: 'telegram'
    })
    expect(validateDraft(state)).toContainEqual({
      code: 'senderIds',
      target: 'telegram'
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
      target: 'telegram.botToken'
    })
  })
})
