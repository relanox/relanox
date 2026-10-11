import { z } from 'zod'

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const platformIdSchema = z.string().min(1).max(256)

const transportOptions = {
  allowInsecureLoopback: z.boolean().default(false)
}

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
  botToken: secretRefSchema,
  botUserId: platformIdSchema,
  apiBaseUrl: z.string().default('https://discord.com/api/v10'),
  gatewayUrl: z.string().default('wss://gateway.discord.gg'),
  ...transportOptions
})

export type DiscordConfig = z.infer<typeof configSchema>

export function validateConfig(input: unknown): DiscordConfig {
  const parsed = configSchema.parse(input)
  validateTransportUrl(parsed.apiBaseUrl, parsed.allowInsecureLoopback)
  validateTransportUrl(parsed.gatewayUrl, parsed.allowInsecureLoopback, true)
  return parsed
}

export const REQUEST_TIMEOUT_MS = 10_000

export const RECONNECT_DELAY_MS = 5000

export const GATEWAY_INTENTS = 37_377
