import { z } from 'zod'

export const frameSchema = z.object({
  op: z.number().int(),
  s: z.number().int().nonnegative().nullish(),
  t: z.string().optional(),
  d: z.unknown().optional()
})

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
  message_scene: z.object({ ext: z.array(z.string()) }).optional(),
  attachments: z
    .array(
      z.object({
        url: z.string().min(1).optional(),
        filename: z.string().optional(),
        content_type: z.string().optional()
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

export const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z
    .union([z.number(), z.string().regex(/^\d+$/u)])
    .transform(Number)
    .pipe(z.number().positive())
})

export const allocationSchema = z.object({
  next: z.number().int().positive(),
  allocations: z.record(
    z.string(),
    z.object({
      mode: z.enum(['passive', 'proactive']),
      seq: z.number().int().positive()
    })
  )
})

export const errorSchema = z.object({ code: z.number().int() })

export const readyEventSchema = z.object({ session_id: z.string().min(1) })

export const helloEventSchema = z.object({
  heartbeat_interval: z.number().int().min(1000).max(300_000)
})

export const gatewayResponseSchema = z.object({ url: z.url() })

export const sendResponseSchema = z.object({ id: z.string().min(1) })
