import { createDingTalkChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createDingTalkChannel> {
  return createDingTalkChannel()
}
