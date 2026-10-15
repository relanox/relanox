import { z } from 'zod'
import { platformIdSchema } from './config.js'

const identitySchema = z.object({ id: platformIdSchema })

export const activitySchema = z.object({
  type: z.string(),
  id: platformIdSchema.optional(),
  channelId: z.string(),
  serviceUrl: z.url(),
  text: z.string().optional(),
  name: z.string().optional(),
  value: z.unknown().optional(),
  attachments: z
    .array(
      z.object({
        contentType: z.string(),
        contentUrl: z.url().optional(),
        name: z.string().optional(),
        content: z.unknown().optional()
      })
    )
    .optional(),
  from: identitySchema,
  recipient: identitySchema,
  conversation: z.object({
    id: platformIdSchema,
    tenantId: platformIdSchema.optional(),
    conversationType: z.string().optional()
  }),
  channelData: z.object({ tenant: z.object({ id: platformIdSchema }) }),
  replyToId: platformIdSchema.optional()
})

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

export const keysSchema = z.object({
  keys: z.array(
    z.object({
      kid: platformIdSchema.optional(),
      endorsements: z.array(z.string()).optional()
    })
  )
})

export const receiptSchema = z.object({ id: platformIdSchema })

export const oauthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive()
})
