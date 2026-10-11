import { z } from 'zod'

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const platformIdSchema = z.string().min(1).max(256)

export function validateTransportUrl(
  value: string,
  insecure: boolean,
  socket = false
): string {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.href.includes('#') ||
    (!socket && url.href.includes('?'))
  ) {
    throw new Error('invalid_transport_url')
  }
  const secure = socket ? 'wss:' : 'https:'
  const local = socket ? 'ws:' : 'http:'
  if (
    url.protocol !== secure &&
    !(
      insecure &&
      url.protocol === local &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  ) {
    throw new Error('insecure_transport_url')
  }
  return url.toString()
}

const configSchema = z.strictObject({
  botToken: secretRefSchema
})

export type DiscordConfig = z.infer<typeof configSchema>

export function validateConfig(input: unknown): DiscordConfig {
  const parsed = configSchema.parse(input)
  return parsed
}

export const REQUEST_TIMEOUT_MS = 10_000

export const RECONNECT_DELAY_MS = 5000

export const GATEWAY_INTENTS = 37_377

export const API_BASE_URL = 'https://discord.com/api/v10'
