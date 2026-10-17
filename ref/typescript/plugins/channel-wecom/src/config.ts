import { z } from 'zod'

const secretRefSchema = z
  .object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u) })
  .strict()

export const websocketConfigSchema = z
  .object({
    mode: z.literal('websocket').optional(),
    botId: z.string().min(1),
    secret: secretRefSchema,
    recipientTypes: z
      .record(z.string().min(1), z.enum(['single', 'group']))
      .optional()
  })
  .strict()

export const webhookConfigSchema = z
  .object({
    mode: z.literal('webhook'),
    botId: z.string().min(1),
    token: secretRefSchema,
    encodingAESKey: secretRefSchema
  })
  .strict()

export const configSchema = z.union([
  websocketConfigSchema,
  webhookConfigSchema
])

export type WebsocketConfig = z.infer<typeof websocketConfigSchema>

export type WebhookConfig = z.infer<typeof webhookConfigSchema>

export type WeComConfig = z.infer<typeof configSchema>

export const WEBSOCKET_URL = 'wss://openws.work.weixin.qq.com'
