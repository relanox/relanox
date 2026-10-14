import { createSlackChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createSlackChannel> {
  return createSlackChannel()
}
