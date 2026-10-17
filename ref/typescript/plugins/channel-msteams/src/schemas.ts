import { z } from 'zod'
import { platformIdSchema } from './config.js'

export const targetSchema = z.strictObject({
  appId: platformIdSchema,
  serviceUrl: z.url(),
  conversationId: platformIdSchema,
  tenantId: platformIdSchema,
  botId: platformIdSchema,
  userId: platformIdSchema,
  replyToId: platformIdSchema.optional(),
  personal: z.boolean().optional()
})
