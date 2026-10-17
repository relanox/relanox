import { createWhatsAppChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createWhatsAppChannel> {
  return createWhatsAppChannel()
}
