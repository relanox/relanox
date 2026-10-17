import type { ChannelPlugin } from '@relanox/sdk'
import { createSignalChannel } from '../../channel-signal/src/index.js'
import { createIrcChannel } from '../../channel-irc/src/index.js'
import { createFeishuChannel } from '../../channel-feishu/src/index.js'
import { createDingTalkChannel } from '../../channel-dingtalk/src/index.js'
import { createQqChannel } from '../../channel-qq/src/index.js'
import { createWeComChannel } from '../../channel-wecom/src/index.js'
import { createWhatsAppChannel } from '../../channel-whatsapp/src/index.js'
import { createTeamsChannel } from '../../channel-msteams/src/index.js'

export const secondaryFactories: Record<string, () => ChannelPlugin<unknown>> =
  {
    signal: createSignalChannel,
    irc: createIrcChannel,
    feishu: createFeishuChannel,
    dingtalk: createDingTalkChannel,
    qq: createQqChannel,
    wecom: createWeComChannel,
    whatsapp: createWhatsAppChannel,
    msteams: createTeamsChannel
  }
