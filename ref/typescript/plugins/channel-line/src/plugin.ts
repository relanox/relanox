import { createLineChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createLineChannel> {
  return createLineChannel()
}
