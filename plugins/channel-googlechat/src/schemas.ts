import { z } from 'zod'
import { platformIdSchema } from './config.js'

export const serviceSchema = z.object({
  type: z.literal('service_account'),
  client_email: z.email(),
  private_key: z.string().min(1).max(16_384)
})

const spaceId = z.string().regex(/^spaces\/[A-Za-z0-9_-]+$/u)

const threadId = z
  .string()
  .regex(/^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/u)

const messageSchema = z.object({
  name: platformIdSchema,
  text: z.string().optional(),
  argumentText: z.string().optional(),
  sender: z.object({ name: platformIdSchema, type: z.string().optional() }),
  attachment: z
    .array(
      z.object({
        contentName: z.string().optional(),
        contentType: z.string().optional(),
        attachmentDataRef: z
          .object({ resourceName: z.string().min(1) })
          .optional(),
        driveDataRef: z.unknown().optional()
      })
    )
    .optional(),
  thread: z.object({ name: threadId }).optional()
})

export const eventSchema = z.object({
  type: z.string(),
  space: z.object({ name: spaceId }).optional(),
  message: messageSchema.optional()
})

export const targetSchema = z.strictObject({
  space: spaceId,
  thread: threadId.optional(),
  scope: z.strictObject({ clientEmail: z.email(), apiBase: z.url() })
})

export const receiptSchema = z.object({ name: platformIdSchema })

export const oauthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional()
})
