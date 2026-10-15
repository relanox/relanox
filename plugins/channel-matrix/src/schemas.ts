import { z } from 'zod'
import { platformIdSchema } from './config.js'

export const textSchema = z.object({
  msgtype: z.literal('m.text'),
  body: z.string().min(1)
})

export const targetSchema = z.strictObject({
  homeserver: z.string(),
  userId: platformIdSchema
})
