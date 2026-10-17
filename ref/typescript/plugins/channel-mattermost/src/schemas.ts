import { z } from 'zod'
import { platformIdSchema } from './config.js'

export const postSchema = z.object({
  id: platformIdSchema,
  user_id: platformIdSchema,
  channel_id: platformIdSchema,
  message: z.string(),
  file_ids: z.array(platformIdSchema).default([]),
  root_id: z.string().default(''),
  create_at: z.number().int().nonnegative(),
  type: z.string().default('')
})

export const targetSchema = z.strictObject({
  serverUrl: z.string(),
  botUserId: platformIdSchema
})
