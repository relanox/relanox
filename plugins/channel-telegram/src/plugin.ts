import { createTelegramChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createTelegramChannel> {
  return createTelegramChannel()
}
