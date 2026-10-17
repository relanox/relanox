import { z } from 'zod'

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const platformIdSchema = z.string().min(1).max(1024)

export function validateEndpointUrl(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password || url.hash || url.protocol !== 'https:') {
    throw new Error('unsafe_endpoint')
  }
  return url
}

const configSchema = z.strictObject({
  appId: platformIdSchema,
  botId: platformIdSchema,
  tenantId: platformIdSchema,
  appSecret: secretRefSchema,
  tokenUrl: z
    .url()
    .default(
      'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token'
    ),
  mediaOrigins: z.array(z.url()).default([]),
  trustedUploadOrigins: z.array(z.url()).default([]),
  trustedServiceOrigins: z.array(z.url()).min(1)
})

export type TeamsConfig = z.infer<typeof configSchema>

export function validateConfig(value: unknown): TeamsConfig {
  const config = configSchema.parse(value)
  const token = new URL(config.tokenUrl)
  if (
    !/^\/[^/]+\/oauth2\/v2\.0\/token$/u.test(token.pathname) ||
    token.search
  ) {
    throw new Error('token_url_must_be_entra_v2_endpoint')
  }
  for (const url of [
    config.tokenUrl,
    ...config.trustedServiceOrigins,
    ...config.mediaOrigins,
    ...config.trustedUploadOrigins
  ]) {
    validateEndpointUrl(url)
  }
  if (
    [
      ...config.trustedServiceOrigins,
      ...config.mediaOrigins,
      ...config.trustedUploadOrigins
    ].some((origin) => new URL(origin).origin !== origin)
  ) {
    throw new Error('service_origins_must_be_origins')
  }
  return config
}
