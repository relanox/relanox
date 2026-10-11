import { createTelegramChannel } from '../../plugins/channel-telegram/src/index.js'
import { createDiscordChannel } from '../../plugins/channel-discord/src/index.js'
import { createSlackChannel } from '../../plugins/channel-slack/src/index.js'
import { createFeishuChannel } from '../../plugins/channel-feishu/src/index.js'
import { createMatrixChannel } from '../../plugins/channel-matrix/src/index.js'
import { createMattermostChannel } from '../../plugins/channel-mattermost/src/index.js'
import { createSignalChannel } from '../../plugins/channel-signal/src/index.js'

export const otherCases = [
  {
    name: 'Telegram',
    plugin: createTelegramChannel(),
    field: 'apiBaseUrl',
    config: { botToken: { env: 'TOKEN' }, webhookSecret: { env: 'SECRET' } }
  },
  {
    name: 'Discord',
    plugin: createDiscordChannel(),
    field: 'apiBaseUrl',
    config: { botToken: { env: 'TOKEN' }, botUserId: 'bot' }
  },
  {
    name: 'Slack',
    plugin: createSlackChannel(),
    field: 'apiBaseUrl',
    config: {
      botToken: { env: 'TOKEN' },
      botUserId: 'bot',
      teamId: 'team',
      appId: 'app',
      receiveMode: 'http',
      signingSecret: { env: 'SECRET' }
    }
  },
  {
    name: 'Feishu',
    plugin: createFeishuChannel(),
    field: 'apiBaseUrl',
    config: {
      appId: 'app',
      appSecret: { env: 'SECRET' },
      verificationToken: { env: 'VERIFY' },
      encryptKey: { env: 'KEY' },
      tenantKey: 'tenant',
      botOpenId: 'bot'
    }
  },
  {
    name: 'Matrix',
    plugin: createMatrixChannel(),
    field: 'homeserver',
    config: { userId: '@bot:example.org', accessToken: { env: 'TOKEN' } }
  },
  {
    name: 'Mattermost',
    plugin: createMattermostChannel(),
    field: 'serverUrl',
    config: { botUserId: 'bot', token: { env: 'TOKEN' } }
  },
  {
    name: 'Signal',
    plugin: createSignalChannel(),
    field: 'serviceUrl',
    config: { account: '+15550000000' }
  }
]
