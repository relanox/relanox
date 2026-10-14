import { createTeamsChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createTeamsChannel> {
  return createTeamsChannel()
}
