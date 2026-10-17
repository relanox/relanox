import { createMattermostChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createMattermostChannel> {
  return createMattermostChannel()
}
