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
    botId: z.string().min(1),
    secret: secretRefSchema,
    wsUrl: z.url().default('wss://openws.work.weixin.qq.com'),
    allowInsecureLoopback: z.boolean().default(false),
    mediaOrigins: z.array(z.url()).default([])
  })
  .strict()
  .superRefine((config, context) => {
    for (const origin of config.mediaOrigins) {
      if (new URL(origin).origin !== origin) {
        context.addIssue({
          code: 'custom',
          message: 'Media origins must be exact origins'
        })
      }
    }
    try {
      validateTransportUrl(config.wsUrl, true, config.allowInsecureLoopback)
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Invalid secure WebSocket URL'
      })
    }
  })

export type WeComConfig = z.infer<typeof configSchema>

export const HEARTBEAT_MS = 30_000

export const MAX_RECONNECT_ATTEMPTS = 20
