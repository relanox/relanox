import { z } from 'zod'

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export function validateBaseUrl(
  value: string,
  allowInsecureLocalhost: boolean
): string {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    /[?#]/u.test(url.href) ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && local && allowInsecureLocalhost))
  ) {
    throw new Error('invalid_base_url')
  }
  return url.href.replace(/\/$/u, '')
}

export const platformIdSchema = z.string().min(1).max(240)

const configSchema = z.strictObject({
  serviceUrl: z.url(),
  account: platformIdSchema,
  selfUuid: platformIdSchema.optional(),
  authorization: secretRefSchema.optional(),
  allowInsecureLocalhost: z.boolean().default(false)
})

export type SignalConfig = z.infer<typeof configSchema>

export function validateConfig(value: unknown): SignalConfig {
  const config = configSchema.parse(value)
  validateBaseUrl(config.serviceUrl, config.allowInsecureLocalhost)
  return config
}
