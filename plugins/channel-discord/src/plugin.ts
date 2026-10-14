import { createDiscordChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createDiscordChannel> {
  return createDiscordChannel()
}
