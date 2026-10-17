import { z } from 'zod'

const secretRefSchema = z
  .object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u) })
  .strict()

export const configSchema = z
  .object({
    appId: z.string().min(1),
    clientSecret: secretRefSchema,
    environment: z.enum(['production', 'sandbox']).default('production'),
    recipientTypes: z
      .record(z.string().min(1), z.enum(['c2c', 'group']))
      .optional()
  })
  .strict()

export type QqConfig = z.infer<typeof configSchema>

export const MAX_RECONNECT_ATTEMPTS = 20

export function apiBase(config: QqConfig): string {
  return config.environment === 'sandbox'
    ? 'https://sandbox.api.sgroup.qq.com'
    : 'https://api.sgroup.qq.com'
}
