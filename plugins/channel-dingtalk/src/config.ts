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
    clientId: z.string().min(1),
    clientSecret: secretRefSchema,
    robotCode: z.string().min(1)
  })
  .strict()

export type DingTalkConfig = z.infer<typeof configSchema>

export const MAX_RECONNECT_ATTEMPTS = 20

export const API_BASE = 'https://api.dingtalk.com'

export const UPLOAD_BASE = 'https://oapi.dingtalk.com'
