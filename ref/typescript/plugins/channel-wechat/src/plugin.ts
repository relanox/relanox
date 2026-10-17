import { createWechatChannel } from './channel.js'

export function createPlugin(): ReturnType<typeof createWechatChannel> {
  return createWechatChannel()
}
