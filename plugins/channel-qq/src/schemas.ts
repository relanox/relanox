import { z } from 'zod'

export const messageSchema = z.object({
  rawEventType: z.string().min(1),
  messageId: z.string().min(1),
  senderId: z.string().min(1),
  senderIsBot: z.boolean().optional(),
  replyTarget: z.object({
    scope: z.enum(['c2c', 'group']),
    targetId: z.string().min(1),
    msgId: z.string().min(1)
  }),
  content: z.string().default(''),
  timestamp: z.iso.datetime({ offset: true }),
  msgType: z.number().int().optional(),
  msgIdx: z.string().min(1).optional(),
  // The SDK does not map the native sequence or the C2C bot flag.
  raw: z.object({
    author: z.object({ bot: z.boolean().optional() }),
    msg_seq: z.number().int().optional()
  }),
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
