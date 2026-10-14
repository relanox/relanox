import { createQqChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createQqChannel> {
  return createQqChannel()
}
