import { z } from 'zod'

export const targetSchema = z.object({
  botId: z.string(),
  apiBaseUrl: z.string()
})

const fileSchema = z.looseObject({
  file_id: z.string().min(1),
  file_size: z.number().int().nonnegative().optional(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  duration: z
    .number()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / 1000)
    .optional()
})

const messageSchema = z.looseObject({
  message_id: z.number().int().positive(),
  message_thread_id: z.number().int().positive().optional(),
  from: z.looseObject({ id: z.number().int(), is_bot: z.boolean() }).optional(),
  chat: z.looseObject({
    id: z.number().int(),
    type: z.enum(['private', 'group', 'supergroup', 'channel'])
  }),
  text: z.string().max(1_048_576).optional(),
  caption: z.string().max(1_048_576).optional(),
  photo: z.array(fileSchema).max(20).optional(),
  audio: fileSchema.optional(),
  voice: fileSchema.optional(),
  video: fileSchema.optional(),
  animation: fileSchema.optional(),
  video_note: fileSchema.optional(),
  document: fileSchema.optional()
})

export const updateSchema = z.looseObject({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional()
})

export const responseSchema = z.looseObject({
  ok: z.boolean(),
  result: z.looseObject({ message_id: z.number().int() }).optional(),
  error_code: z.number().optional(),
  parameters: z
    .looseObject({ retry_after: z.number().positive().optional() })
    .optional()
})

export const fileResponseSchema = z.discriminatedUnion('ok', [
  z.looseObject({
    ok: z.literal(true),
    result: z.looseObject({
      file_path: z.string().min(1),
      file_size: z.number().int().nonnegative().optional()
    })
  }),
  z.looseObject({
    ok: z.literal(false),
    error_code: z.number().int(),
    description: z.string()
  })
])
