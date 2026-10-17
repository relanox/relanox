import { z } from 'zod'

const secretRefSchema = z
  .object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u) })
  .strict()

export const configSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: secretRefSchema,
    robotCode: z.string().min(1),
    recipientTypes: z
      .record(z.string().min(1), z.enum(['single', 'group']))
      .optional()
  })
  .strict()

export type DingTalkConfig = z.infer<typeof configSchema>

export const API_BASE = 'https://api.dingtalk.com'

export const UPLOAD_BASE = 'https://oapi.dingtalk.com'
