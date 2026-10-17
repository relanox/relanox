import { createGoogleChatChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createGoogleChatChannel> {
  return createGoogleChatChannel()
}
