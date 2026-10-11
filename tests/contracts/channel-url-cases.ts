import { createTelegramChannel } from '../../plugins/channel-telegram/src/index.js'
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
    name: 'Matrix',
    plugin: createMatrixChannel(),
    field: 'homeserver',
    config: { accessToken: { env: 'TOKEN' } }
  },
  {
    name: 'Mattermost',
    plugin: createMattermostChannel(),
    field: 'serverUrl',
    config: { token: { env: 'TOKEN' } }
  },
  {
    name: 'Signal',
    plugin: createSignalChannel(),
    field: 'serviceUrl',
    config: { account: '+15550000000' }
  }
]
