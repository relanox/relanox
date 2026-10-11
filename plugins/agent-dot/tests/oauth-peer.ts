import { createHash, randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import { z } from 'zod'
import type { CoreRuntime } from '@relanox/core'

export const redirectUri =
  'https://chatgpt.com/connector_platform_oauth_redirect'

export const origin = 'https://relanox.test'
export const resource = `${origin}/agents/dot/mcp/endpoint0`
export const issuer = `${origin}/agents/dot/oauth/endpoint0`
export const password = 'oauth-test-owner-password-32-bytes-minimum'

const tokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.literal(3600),
  scope: z.string()
})

export type Tokens = z.infer<typeof tokensSchema>

export type Pending = {
  clientId: string
  verifier: string
  cookie: string
  request: string
}

export async function postForm(
  core: CoreRuntime,
  path: string,
  values: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return core.fetch(
    new Request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...headers
      },
      body: new URLSearchParams(values)
    })
  )
}

export async function register(
  core: CoreRuntime,
  values: Record<string, unknown> = {}
): Promise<string> {
  const response = await core.fetch(
    new Request(`${issuer}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: [redirectUri],
        ...values
      })
    })
  )

  expect(response.status).toBe(201)
  return z.object({ client_id: z.string() }).parse(await response.json())
    .client_id
}

export function authorizationUrl(
  clientId: string,
  verifier: string,
  values: Record<string, string> = {}
): URL {
  const url = new URL(`${issuer}/authorize`)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'relanox offline_access',
    resource,
    state: 'state-from-native-client',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...values
  }).toString()
  return url
}

export async function begin(
  core: CoreRuntime,
  clientId?: string
): Promise<Pending> {
  const id = clientId ?? (await register(core))
  const verifier = randomBytes(32).toString('base64url')
  const page = await core.fetch(new Request(authorizationUrl(id, verifier)))
  expect(page.status).toBe(200)
  expect(page.headers.get('content-security-policy')).toContain(
    'https://chatgpt.com'
  )
  const html = await page.text()

  const request = /name="request" value="(?<request>[A-Za-z0-9_-]+)"/u.exec(
    html
  )?.groups?.request

  const cookie = page.headers.get('set-cookie')?.split(';')[0]
  if (!request || !cookie) {
    throw new Error('missing_consent_form')
  }
  return { clientId: id, verifier, cookie, request }
}

export async function approve(
  core: CoreRuntime,
  pending: Pending
): Promise<string> {
  const result = await postForm(
    core,
    `${issuer}/authorize`,
    { request: pending.request, password, decision: 'allow' },
    { Origin: origin, Cookie: pending.cookie }
  )

  expect(result.status).toBe(303)

  const location = new URL(
    result.headers.get('location') ?? 'https://invalid.test'
  )

  expect(location.origin + location.pathname).toBe(redirectUri)
  expect(location.searchParams.get('state')).toBe('state-from-native-client')
  expect(location.searchParams.get('iss')).toBe(issuer)
  const code = location.searchParams.get('code')
  if (!code) {
    throw new Error('missing_authorization_code')
  }
  return code
}

export async function exchange(
  core: CoreRuntime,
  pending: Pending,
  code: string,
  values: Record<string, string> = {}
): Promise<Response> {
  return postForm(core, `${issuer}/token`, {
    grant_type: 'authorization_code',
    client_id: pending.clientId,
    redirect_uri: redirectUri,
    resource,
    code,
    code_verifier: pending.verifier,
    ...values
  })
}

export async function tokenResponse(response: Response): Promise<Tokens> {
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return tokensSchema.parse(await response.json())
}

export async function refresh(
  core: CoreRuntime,
  pending: Pending,
  token: string,
  values: Record<string, string> = {}
): Promise<Response> {
  return postForm(core, `${issuer}/token`, {
    grant_type: 'refresh_token',
    client_id: pending.clientId,
    resource,
    refresh_token: token,
    ...values
  })
}
