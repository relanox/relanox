import { z } from 'zod'

export const messageSchema = z.object({
  id: z.string().min(1),
  author: z.object({
    user_openid: z.string().min(1).optional(),
    member_openid: z.string().min(1).optional(),
    bot: z.boolean().optional()
  }),
  content: z.string().default(''),
  timestamp: z.iso.datetime({ offset: true }),
  group_openid: z.string().min(1).optional(),
  message_type: z.number().int().optional(),
  msg_seq: z.number().int().optional(),
  message_scene: z.object({ ext: z.array(z.string()).optional() }).optional(),
  attachments: z
    .array(
      z.object({
        url: z.string().min(1).optional(),
        filename: z.string().optional(),
        content_type: z.string().optional(),
        asr_refer_text: z.string().optional()
      })
    )
    .optional()
})

export const targetSchema = z
  .object({
    type: z.enum(['c2c', 'group']),
    msgId: z.string().min(1).optional(),
    messageAt: z.number().int().nonnegative().optional(),
    scope: z.object({ appId: z.string().min(1), apiBase: z.url() }).strict()
  })
  .strict()
  .refine(
    (value) => (value.msgId === undefined) === (value.messageAt === undefined)
  )

export const errorSchema = z.object({ code: z.number().int() })

export const sendResponseSchema = z.object({ id: z.string().min(1) })
