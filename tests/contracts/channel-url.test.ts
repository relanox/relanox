import { otherCases } from './channel-url-cases.js'
import { createDiscordChannel } from '../../plugins/channel-discord/src/index.js'
import { describe, expect, it } from 'vitest'
import { createLineChannel } from '../../plugins/channel-line/src/index.js'
import { createWhatsAppChannel } from '../../plugins/channel-whatsapp/src/index.js'
import { createGoogleChatChannel } from '../../plugins/channel-googlechat/src/index.js'
import { createQqChannel } from '../../plugins/channel-qq/src/index.js'
import { createDingTalkChannel } from '../../plugins/channel-dingtalk/src/index.js'

const cases = [
  {
    name: 'WhatsApp',
    plugin: createWhatsAppChannel(),
    config: {
      phoneNumberId: 'phone',
      businessAccountId: 'business',
      appSecret: { env: 'SECRET' },
      verifyToken: { env: 'VERIFY' },
      accessToken: { env: 'TOKEN' },
      apiVersion: 'v25.0'
    }
  },
  {
    name: 'QQ',
    plugin: createQqChannel(),
    config: { appId: 'app', clientSecret: { env: 'SECRET' } }
  },
  {
    name: 'DingTalk',
    plugin: createDingTalkChannel(),
    config: {
      clientId: 'app',
      robotCode: 'robot',
      clientSecret: { env: 'SECRET' }
    }
  }
].map((entry) => ({
  name: entry.name,
  plugin: entry.plugin,
  config: entry.config,
  field: 'apiBase'
}))

const boundaries = [...cases, ...otherCases].flatMap((entry) =>
  ['?route=bot', '?', '#', '#fragment'].map((suffix) => ({
    name: entry.name,
    plugin: entry.plugin,
    config: entry.config,
    field: entry.field,
    suffix
  }))
)

describe('channel API base URL contract', () => {
  it.each(boundaries)(
    "$name rejects API base suffix '$suffix' before any request",
    ({ plugin, config, field, suffix }) => {
      expect(() =>
        plugin.validateConfig({
          ...config,
          [field]: 'https://api.example/proxy%3F%23/'
        })
      ).not.toThrow()
      expect(() =>
        plugin.validateConfig({
          ...config,
          [field]: `https://api.example/proxy/${suffix}`
        })
      ).toThrow()
    }
  )

  it('preserves query parameters on the complete Discord Gateway URL', () => {
    const config = createDiscordChannel().validateConfig({
      botUserId: 'bot',
      botToken: { env: 'TOKEN' },
      gatewayUrl: 'wss://gateway.example/?v=10&encoding=json'
    })

    expect(config.gatewayUrl).toBe('wss://gateway.example/?v=10&encoding=json')
  })

  it.each(['apiBase', 'tokenUrl', 'jwksUrl', 'allowLoopback'])(
    'rejects removed Google Chat endpoint setting %s',
    (field) => {
      expect(() =>
        createGoogleChatChannel().validateConfig({
          serviceAccount: { env: 'SERVICE' },
          [field]: 'https://operator.example'
        })
      ).toThrow()
    }
  )

  it.each(['botUserId', 'apiBase', 'contentApiBase', 'allowLoopback'])(
    'rejects removed LINE setting %s',
    (field) => {
      expect(() =>
        createLineChannel().validateConfig({
          channelSecret: { env: 'SECRET' },
          accessToken: { env: 'TOKEN' },
          [field]: 'https://operator.example'
        })
      ).toThrow()
    }
  )
})
