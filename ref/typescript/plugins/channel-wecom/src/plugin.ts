import { createWeComChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createWeComChannel> {
  return createWeComChannel()
}
