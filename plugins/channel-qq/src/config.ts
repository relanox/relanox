import { z } from 'zod'

const secretRefSchema = z
  .object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u) })
  .strict()

export function validateTransportUrl(
  value: string,
  websocket: boolean,
  allowLoopback: boolean
): string {
  const url = new URL(value)
  const secure = websocket ? 'wss:' : 'https:'
  const local = websocket ? 'ws:' : 'http:'
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== secure &&
      !(
        allowLoopback &&
        url.protocol === local &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      ))
  ) {
    throw new Error('insecure_transport_url')
  }
  return url.toString()
}

export const configSchema = z
  .object({
    appId: z.string().min(1),
    clientSecret: secretRefSchema,
    environment: z.enum(['production', 'sandbox']).default('production'),
    allowProactive: z.boolean().default(false),
    recipientTypes: z
      .record(z.string().min(1), z.enum(['c2c', 'group']))
      .optional()
  })
  .strict()

export type QqConfig = z.infer<typeof configSchema>

export const MAX_RECONNECT_ATTEMPTS = 20

export const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

export function apiBase(config: QqConfig): string {
  return config.environment === 'sandbox'
    ? 'https://sandbox.api.sgroup.qq.com'
    : 'https://api.sgroup.qq.com'
}
