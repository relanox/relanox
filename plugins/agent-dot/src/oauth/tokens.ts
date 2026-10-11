import { equalSecret } from '@relanox/agent-mcp'
import {
  digest,
  familySchema,
  grantSchema,
  lifetime,
  OAuthError,
  oauthJson,
  opaque,
  requestedScope,
  tokenSchema
} from './protocol.js'
import type { Token } from './protocol.js'
import type { OAuthStore } from './store.js'

export function createTokens(
  store: OAuthStore,
  resource: string
): {
  code(form: URLSearchParams): Promise<Response>
  refresh(form: URLSearchParams): Promise<Response>
  verify(request: Request): Promise<boolean>
} {
  async function issue(data: Token, refreshToken: string): Promise<Response> {
    const access = await store.issue('access', data, lifetime.access)
    return oauthJson({
      access_token: access,
      token_type: 'Bearer',
      expires_in: lifetime.access / 1000,
      refresh_token: refreshToken,
      scope: data.scope
    })
  }

  function validateResource(form: URLSearchParams): void {
    if (form.get('resource') !== resource) {
      throw new OAuthError('invalid_target')
    }
  }

  async function code(form: URLSearchParams): Promise<Response> {
    validateResource(form)

    const { entry, data } = await store.load(
      'code',
      form.get('code') ?? '',
      grantSchema
    )

    const verifier = form.get('code_verifier') ?? ''
    if (
      data.clientId !== form.get('client_id') ||
      data.redirectUri !== form.get('redirect_uri') ||
      data.resource !== resource ||
      !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) ||
      !equalSecret(digest(verifier), data.challenge)
    ) {
      throw new OAuthError('invalid_grant')
    }
    await store.consume(entry)
    const refreshToken = opaque()

    const token: Token = {
      clientId: data.clientId,
      resource,
      scope: data.scope,
      family: opaque()
    }

    await store.save(
      'family',
      token.family,
      { current: digest(refreshToken) },
      lifetime.refresh
    )
    await store.save('refresh', refreshToken, token, lifetime.refresh)
    return issue(token, refreshToken)
  }

  async function refresh(form: URLSearchParams): Promise<Response> {
    validateResource(form)
    const value = form.get('refresh_token') ?? ''
    const { data } = await store.load('refresh', value, tokenSchema)
    if (data.clientId !== form.get('client_id') || data.resource !== resource) {
      throw new OAuthError('invalid_grant')
    }
    if (form.has('scope') && requestedScope(form.get('scope')) !== data.scope) {
      throw new OAuthError('invalid_scope')
    }
    const family = await store.load('family', data.family, familySchema)
    if (!equalSecret(family.data.current, digest(value))) {
      // A used refresh token indicates replay. Revoke its whole family, including access tokens.
      await store.consume(family.entry)
      throw new OAuthError('invalid_grant')
    }
    const next = opaque()
    await store.update(family.entry, { current: digest(next) })
    await store.save(
      'refresh',
      next,
      data,
      Math.max(1, (family.entry.expiresAt ?? 0) - Date.now())
    )
    return issue(data, next)
  }

  async function verify(request: Request): Promise<boolean> {
    const match = /^Bearer (?<token>[A-Za-z0-9_-]{43})$/u.exec(
      request.headers.get('authorization') ?? ''
    )

    if (!match?.groups?.token) {
      return false
    }
    const entry = await store.read('access', match.groups.token)
    const parsed = tokenSchema.safeParse(entry?.value)
    if (
      !parsed.success ||
      parsed.data.resource !== resource ||
      !parsed.data.scope.split(' ').includes('relanox')
    ) {
      return false
    }
    return (await store.read('family', parsed.data.family)) !== undefined
  }

  return { code, refresh, verify }
}
