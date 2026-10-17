import { createDingTalkChannel } from '../../plugins/channel-dingtalk/src/index.js'
import { createWeComChannel } from '../../plugins/channel-wecom/src/index.js'
import { createQqChannel } from '../../plugins/channel-qq/src/index.js'
import { createWhatsAppChannel } from '../../plugins/channel-whatsapp/src/index.js'
import { createDiscordChannel } from '../../plugins/channel-discord/src/index.js'
import { createSlackChannel } from '../../plugins/channel-slack/src/index.js'
import { createFeishuChannel } from '../../plugins/channel-feishu/src/index.js'

export const hostedCases = [
  {
    name: 'Discord',
    plugin: createDiscordChannel(),
    config: { botToken: { env: 'TOKEN' } },
    fields: ['botUserId', 'apiBaseUrl', 'gatewayUrl', 'allowInsecureLoopback']
  },
  {
    name: 'Slack',
    plugin: createSlackChannel(),
    config: {
      botToken: { env: 'TOKEN' },
      appId: 'app',
      signingSecret: { env: 'SECRET' }
    },
    fields: [
      'botUserId',
      'teamId',
      'receiveMode',
      'apiBaseUrl',
      'allowInsecureLoopback'
    ]
  },
  {
    name: 'Feishu',
    plugin: createFeishuChannel(),
    config: {
      appId: 'app',
      appSecret: { env: 'SECRET' },
      verificationToken: { env: 'VERIFY' },
      encryptKey: { env: 'KEY' },
      tenantKey: 'tenant'
    },
    fields: ['botOpenId', 'apiBaseUrl', 'allowInsecureLoopback']
  },
  {
    name: 'DingTalk',
    plugin: createDingTalkChannel(),
    config: {
      clientId: 'app',
      clientSecret: { env: 'SECRET' },
      robotCode: 'robot'
    },
    fields: ['apiBase', 'uploadBase', 'mediaOrigins', 'allowInsecureLoopback']
  },
  {
    name: 'WeCom',
    plugin: createWeComChannel(),
    config: { botId: 'bot', secret: { env: 'SECRET' } },
    fields: ['wsUrl', 'mediaOrigins', 'allowInsecureLoopback']
  },
  {
    name: 'QQ',
    plugin: createQqChannel(),
    config: { appId: 'app', clientSecret: { env: 'SECRET' } },
    fields: ['apiBase', 'mediaOrigins', 'allowInsecureLoopback']
  },
  {
    name: 'WhatsApp',
    plugin: createWhatsAppChannel(),
    config: {
      phoneNumberId: 'phone',
      businessAccountId: 'business',
      appSecret: { env: 'SECRET' },
      verifyToken: { env: 'VERIFY' },
      accessToken: { env: 'TOKEN' }
    },
    fields: ['apiBase', 'apiVersion', 'allowLoopback']
  }
]
