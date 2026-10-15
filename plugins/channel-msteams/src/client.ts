import type { SendResult } from '@relanox/sdk'
import type { TeamsConfig } from './config.js'
import { validateEndpointUrl } from './config.js'
import { failure, secret } from './io.js'
import { z } from 'zod'
import { OAuthSession, sessionToken } from './oauth.js'

const sessions = new WeakMap<TeamsConfig, OAuthSession>()

const oauthFailureSchema = z.object({
  output: z.object({ statusCode: z.number().int().min(100).max(599) }),
  data: z
    .object({ headers: z.object({ 'retry-after': z.string().optional() }) })
    .optional()
})

function session(config: TeamsConfig): OAuthSession {
  const credential = secret(config.appSecret)
  const endpoint = validateEndpointUrl(config.tokenUrl).href
  let client = sessions.get(config)
  if (
    !client ||
    client.credential !== credential ||
    client.endpoint !== endpoint ||
    client.appId !== config.appId
  ) {
    client = new OAuthSession(endpoint, config.appId, credential)
    sessions.set(config, client)
  }
  return client
}

export function invalidateAccessToken(
  config: TeamsConfig,
  token: string
): void {
  sessions.get(config)?.invalidate(token)
}

export async function accessToken(
  config: TeamsConfig,
  signal: AbortSignal
): Promise<string | SendResult> {
  try {
    return await sessionToken(session(config), signal)
  } catch (error) {
    const parsed = oauthFailureSchema.safeParse(error)
    if (parsed.success) {
      const status = parsed.data.output.statusCode
      const retryAfter = parsed.data.data?.headers['retry-after']
      return status >= 500
        ? { status: 'retryable', errorCode: 'oauth_unavailable' }
        : failure(
            new Response(null, {
              status,
              headers: retryAfter ? { 'retry-after': retryAfter } : {}
            })
          )
    }
    return { status: 'retryable', errorCode: 'oauth_unavailable' }
  }
}

export function serviceUrl(value: string, config: TeamsConfig): URL {
  const url = validateEndpointUrl(value)
  if (
    /[?#]/u.test(url.href) ||
    !config.trustedServiceOrigins.includes(url.origin)
  ) {
    throw new Error('untrusted_service_origin')
  }
  return url
}
