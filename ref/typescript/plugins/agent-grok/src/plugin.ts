import { createGrokAgentPlugin } from './index.js'

export function createPlugin(): ReturnType<typeof createGrokAgentPlugin> {
  return createGrokAgentPlugin()
}
