import type { ChannelPlugin } from '@relanox/sdk'
import { createTelegramChannel } from '../src/index.js'
import { createDiscordChannel } from '../../channel-discord/src/index.js'
import { createSlackChannel } from '../../channel-slack/src/index.js'
import { createMatrixChannel } from '../../channel-matrix/src/index.js'
import { createMattermostChannel } from '../../channel-mattermost/src/index.js'
import { createGoogleChatChannel } from '../../channel-googlechat/src/index.js'
import { createLineChannel } from '../../channel-line/src/index.js'

export const primaryFactories: Record<string, () => ChannelPlugin<unknown>> = {
  telegram: createTelegramChannel,
  discord: createDiscordChannel,
  slack: createSlackChannel,
  matrix: createMatrixChannel,
  mattermost: createMattermostChannel,
  googlechat: createGoogleChatChannel,
  line: createLineChannel
}
