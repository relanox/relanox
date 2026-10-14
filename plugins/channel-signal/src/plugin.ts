import { createSignalChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createSignalChannel> {
  return createSignalChannel()
}
