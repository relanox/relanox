import { z } from 'zod'

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const platformIdSchema = z.string().min(1).max(1024)

export function validateEndpointUrl(
  value: string,
  allowLoopback: boolean
): URL {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(allowLoopback && loopback && url.protocol === 'http:'))
  ) {
    throw new Error('unsafe_endpoint')
  }
  return url
}

const configSchema = z.strictObject({
  phoneNumberId: platformIdSchema,
  businessAccountId: platformIdSchema,
  appSecret: secretRefSchema,
  verifyToken: secretRefSchema,
  accessToken: secretRefSchema
})

export type WhatsAppConfig = z.infer<typeof configSchema>

export function validateConfig(value: unknown): WhatsAppConfig {
  const config = configSchema.parse(value)
  return config
}

export const API_BASE = 'https://graph.facebook.com'

export const API_VERSION = 'v25.0'
