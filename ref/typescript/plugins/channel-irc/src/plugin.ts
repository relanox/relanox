import { createIrcChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createIrcChannel> {
  return createIrcChannel()
}
