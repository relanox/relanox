import { z } from 'zod'
import { platformIdSchema } from './config.js'

export const targetSchema = z.object({
  teamId: platformIdSchema,
  appId: platformIdSchema,
  botId: platformIdSchema,
  apiBaseUrl: z.string()
})

export const fileSchema = z.looseObject({
  id: platformIdSchema,
  name: z.string().nullish(),
  mimetype: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  url_private: z.url().optional(),
  url_private_download: z.url().optional()
})

export const envelopeSchema = z.looseObject({
  type: z.string(),
  team_id: platformIdSchema.optional(),
  api_app_id: platformIdSchema.optional(),
  event_id: platformIdSchema.optional(),
  event: z.unknown().optional(),
  challenge: platformIdSchema.optional()
})

export const messageSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  bot_id: platformIdSchema.optional(),
  user: platformIdSchema.optional(),
  channel: platformIdSchema.optional(),
  ts: z
    .string()
    .regex(/^\d+\.\d+$/u)
    .optional(),
  thread_ts: z
    .string()
    .regex(/^\d+\.\d+$/u)
    .optional(),
  root: z
    .looseObject({ thread_ts: z.string().regex(/^\d+\.\d+$/u) })
    .optional(),
  text: z
    .string()
    .max(1024 * 1024)
    .optional(),
  files: z.array(fileSchema).max(10).default([])
})
