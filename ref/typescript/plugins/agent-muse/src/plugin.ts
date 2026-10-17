import { createMuseAgentPlugin } from './index.js'

export function createPlugin(): ReturnType<typeof createMuseAgentPlugin> {
  return createMuseAgentPlugin()
}
