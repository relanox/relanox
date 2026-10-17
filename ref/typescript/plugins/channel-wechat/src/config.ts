import { z } from 'zod'

const schema = z.strictObject({
  botId: z.string().min(1).max(256),
  botToken: z.strictObject({
    env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  }),
  apiBaseUrl: z.string().default('https://ilinkai.weixin.qq.com'),
  cdnBaseUrl: z.string().default('https://novac2c.cdn.weixin.qq.com/c2c'),
  allowInsecureLoopback: z.boolean().default(false)
})

export type WechatConfig = z.infer<typeof schema>

export function transportUrl(value: string, insecure: boolean): URL {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        insecure &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new Error('invalid_transport_url')
  }
  return url
}

export function validateConfig(value: unknown): WechatConfig {
  const result = schema.parse(value)
  transportUrl(result.apiBaseUrl, result.allowInsecureLoopback)
  transportUrl(result.cdnBaseUrl, result.allowInsecureLoopback)
  return result
}
