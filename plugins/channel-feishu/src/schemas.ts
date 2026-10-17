import { z } from 'zod'
import { platformIdSchema } from './config.js'

export const targetSchema = z.object({
  tenantKey: platformIdSchema,
  appId: platformIdSchema,
  botId: platformIdSchema,
  apiBaseUrl: z.string(),
  threadAnchor: platformIdSchema.optional()
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
    chat_type: z.enum(['p2p', 'group']),
    message_type: platformIdSchema,
    content: z.string().max(1024 * 1024),
    create_time: z.string(),
    mentions: z
      .array(
        z.looseObject({
          key: z.string(),
          name: z.string().optional(),
          id: z.looseObject({ open_id: z.string().optional() })
        })
      )
      .optional(),
    root_id: platformIdSchema.optional(),
    parent_id: platformIdSchema.optional(),
    thread_id: platformIdSchema.optional()
  })
})

export const encryptedEventSchema = z.object({
  encrypt: z
    .string()
    .min(1)
    .max(1024 * 1024)
})
