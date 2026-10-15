import { z } from 'zod'
import { platformIdSchema } from './config.js'

const relationSchema = z.object({
  rel_type: z.string().optional(),
  event_id: platformIdSchema.optional(),
  'm.in_reply_to': z.object({ event_id: platformIdSchema }).optional()
})

export const eventSchema = z.object({
  event_id: platformIdSchema,
  sender: platformIdSchema,
  type: platformIdSchema,
  origin_server_ts: z.number().int().nonnegative().optional(),
  content: z.record(z.string(), z.unknown())
})

export type InboundEvent = z.infer<typeof eventSchema>

export const identitySchema = z.object({ user_id: platformIdSchema })

export const textSchema = z.object({
  msgtype: z.literal('m.text'),
  body: z.string().min(1),
  'm.relates_to': relationSchema.optional()
})

export const targetSchema = z.strictObject({
  homeserver: z.string(),
  userId: platformIdSchema
})
