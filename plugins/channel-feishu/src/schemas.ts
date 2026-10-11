import { z } from 'zod'
import { platformIdSchema } from './config.js'

export const targetSchema = z.object({
  tenantKey: platformIdSchema,
  appId: platformIdSchema,
  botId: platformIdSchema,
  apiBaseUrl: z.string()
})

const headerSchema = z.looseObject({
  event_id: platformIdSchema,
  event_type: platformIdSchema,
  app_id: platformIdSchema,
  tenant_key: platformIdSchema,
  token: platformIdSchema
})

export const challengeSchema = z.looseObject({
  type: z.literal('url_verification'),
  token: platformIdSchema,
  challenge: platformIdSchema
})

export const eventSchema = z.looseObject({
  schema: z.literal('2.0'),
  header: headerSchema,
  event: z.unknown()
})

export const messageSchema = z.looseObject({
  sender: z.looseObject({
    sender_type: platformIdSchema,
    sender_id: z.looseObject({ open_id: platformIdSchema.optional() }),
    tenant_key: platformIdSchema.optional()
  }),
  message: z.looseObject({
    message_id: platformIdSchema,
    chat_id: platformIdSchema,
    chat_type: platformIdSchema,
    message_type: platformIdSchema,
    content: z.string().max(1_048_576),
    create_time: z.string(),
    root_id: platformIdSchema.optional(),
    parent_id: platformIdSchema.optional(),
    thread_id: platformIdSchema.optional()
  })
})

export const apiSchema = z.looseObject({
  code: z.number().int(),
  data: z.looseObject({ message_id: platformIdSchema.optional() }).optional()
})

export const tenantTokenResponseSchema = z.looseObject({
  code: z.number().int(),
  tenant_access_token: platformIdSchema.optional(),
  expire: z.number().positive().optional()
})

export const encryptedEventSchema = z.object({
  encrypt: z.string().min(1).max(1_048_576)
})

export const textContentSchema = z.looseObject({
  text: z.string().min(1).max(1_048_576)
})
