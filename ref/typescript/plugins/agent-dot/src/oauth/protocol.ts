import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

export const scope = 'relanox'

export const lifetime = {
  pending: 300_000,
  code: 300_000,
  access: 3_600_000,
  refresh: 2_592_000_000,
  client: 31_536_000_000
}

export const opaque = (): string => randomBytes(32).toString('base64url')

export const digest = (value: string): string =>
  createHash('sha256').update(value).digest('base64url')

const bounded = z.string().min(1).max(2048)

export const clientSchema = z.object({
  client_id: bounded,
  client_name: z.string().max(100),
  redirect_uris: z.array(z.url()).min(1).max(10),
  token_endpoint_auth_method: z.literal('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])),
  response_types: z.array(z.literal('code'))
})

export type OAuthClient = z.infer<typeof clientSchema>

export const grantSchema = z.object({
  clientId: bounded,
  redirectUri: z.url(),
  resource: z.url(),
  scope: bounded,
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  state: z.string().max(2048)
})

export type Grant = z.infer<typeof grantSchema>

export const pendingSchema = z.object({
  grant: grantSchema,
  csrf: bounded,
  attempts: z.number().int().min(0).max(10)
})

export const tokenSchema = z.object({
  clientId: bounded,
  resource: z.url(),
  scope: bounded,
  family: bounded
})

export type Token = z.infer<typeof tokenSchema>

export const familySchema = z.object({ current: bounded })

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400
  ) {
    super(code)
    this.name = 'OAuthError'
  }
}

export function oauthJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer'
    }
  })
}

/** Native ChatGPT callbacks only; registration cannot turn consent into an arbitrary redirect. */
export function nativeRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.origin === 'https://chatgpt.com' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      (url.pathname === '/connector_platform_oauth_redirect' ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]+$/u.test(url.pathname))
    )
  } catch {
    return false
  }
}

export function requestedScope(value: string | null): string {
  const requested = [...new Set((value ?? scope).split(' ').filter(Boolean))]
  if (
    !requested.includes(scope) ||
    requested.some((item) => ![scope, 'offline_access'].includes(item))
  ) {
    throw new OAuthError('invalid_scope')
  }
  return requested.toSorted().join(' ')
}

export function singleParameters(parameters: URLSearchParams): URLSearchParams {
  if (
    [...parameters.keys()].some((key) => parameters.getAll(key).length !== 1)
  ) {
    throw new OAuthError('invalid_request')
  }
  return parameters
}

export async function formBody(request: Request): Promise<URLSearchParams> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/x-www-form-urlencoded'
  ) {
    throw new OAuthError('invalid_request')
  }
  return singleParameters(new URLSearchParams(await request.text()))
}
