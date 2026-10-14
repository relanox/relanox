import { createDotAgentPlugin } from './index.js'

export function createPlugin(): ReturnType<typeof createDotAgentPlugin> {
  return createDotAgentPlugin()
}
