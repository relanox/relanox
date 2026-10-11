import { z } from 'zod'
import { platformIdSchema } from './config.js'

export const frameSchema = z.object({
  event: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  seq_reply: z.number().int().optional(),
  status: z.string().optional()
})

export const postSchema = z.object({
  id: platformIdSchema,
  user_id: platformIdSchema,
  channel_id: platformIdSchema,
  message: z.string(),
  file_ids: z.array(platformIdSchema).max(10).default([]),
  root_id: z.string().default(''),
  create_at: z.number().int().nonnegative(),
  type: z.string().default('')
})

export const targetSchema = z.strictObject({
  serverUrl: z.string(),
  botUserId: platformIdSchema
})

export const postedEventSchema = z.object({ post: z.string().max(1_048_576) })

export const sendResponseSchema = z.object({ id: platformIdSchema })
