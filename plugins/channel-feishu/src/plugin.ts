import { createFeishuChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createFeishuChannel> {
  return createFeishuChannel()
}
