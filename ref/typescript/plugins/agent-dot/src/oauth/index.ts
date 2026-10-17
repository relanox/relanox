import { equalSecret, resolveAgentSecret } from '@relanox/agent-mcp'
import type { AuthenticateMcpRequest } from '@relanox/agent-mcp'
import type { AgentHost } from '@relanox/sdk'
import { validatePublicUrl } from '@relanox/sdk'
import type { DotConfig } from '../config.js'
import { createConsent } from './consent.js'
import { formBody, OAuthError, oauthJson, scope } from './protocol.js'
import { createOAuthStore } from './store.js'
import { createTokens } from './tokens.js'
import { createClientRegistry } from './clients.js'

/** Per-Agent OAuth 2.1 authorization-code server for native ChatGPT connections. */
export function mountOAuth(
  host: AgentHost,
  endpointId: string,
  config: DotConfig
): AuthenticateMcpRequest {
  const origin = validatePublicUrl(host.publicUrl ?? '')
  if (!origin.startsWith('https:')) {
    throw new Error('dot_oauth_requires_https')
  }
  const secret = resolveAgentSecret(config.mcp.token)
  if (secret.length < 32) {
    throw new Error('dot_oauth_password_too_short')
  }
  const resource = `${origin}/agents/dot/mcp/${endpointId}`
  const issuer = `${origin}/agents/dot/oauth/${endpointId}`
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/agents/dot/mcp/${endpointId}`
  const store = createOAuthStore(host.state, endpointId, secret)
  const tokens = createTokens(store, resource)
  const clients = createClientRegistry(secret, resource)

  const consent = createConsent(
    store,
    resource,
    issuer,
    secret,
    endpointId,
    clients
  )

  function hostGuard(request: Request): Response | undefined {
    const url = new URL(request.url)
    if (
      url.host !== new URL(origin).host ||
      (request.headers.get('host') ?? url.host) !== url.host
    ) {
      return oauthJson({ error: 'invalid_request' }, 403)
    }
    return undefined
  }

  function mount(
    path: string,
    method: 'GET' | 'POST',
    handler: (request: Request) => Promise<Response>
  ): void {
    host.mountHttp(
      path,
      async (request) => {
        const forbidden = hostGuard(request)
        if (forbidden) {
          return forbidden
        }
        if (request.method !== method) {
          return new Response(null, { status: 405, headers: { Allow: method } })
        }
        try {
          return await handler(request)
        } catch (error) {
          return oauthJson(
            {
              error:
                error instanceof OAuthError ? error.code : 'invalid_request'
            },
            error instanceof OAuthError ? error.status : 400
          )
        }
      },
      { maxBodyBytes: 16_384, authorize: async (request) => hostGuard(request) }
    )
  }

  mount(
    `/.well-known/oauth-protected-resource/mcp/${endpointId}`,
    'GET',
    async () =>
      oauthJson({
        resource,
        authorization_servers: [issuer],
        scopes_supported: [scope, 'offline_access'],
        bearer_methods_supported: ['header']
      })
  )
  mount(
    `/.well-known/oauth-authorization-server/oauth/${endpointId}`,
    'GET',
    async () =>
      oauthJson({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: [scope, 'offline_access'],
        authorization_response_iss_parameter_supported: true
      })
  )
  mount(`/oauth/${endpointId}/register`, 'POST', async (request) => {
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json'
    ) {
      throw new OAuthError('invalid_client_metadata')
    }
    const client = clients.register(await request.json())
    return oauthJson(
      { ...client, client_id_issued_at: Math.floor(Date.now() / 1000) },
      201
    )
  })
  // GET displays consent; POST authenticates the owner and issues a single-use code.
  host.mountHttp(
    `/oauth/${endpointId}/authorize`,
    async (request) => {
      const forbidden = hostGuard(request)
      if (forbidden) {
        return forbidden
      }
      try {
        if (request.method === 'GET') {
          return await consent.begin(request)
        }
        if (request.method === 'POST') {
          return await consent.finish(request, await formBody(request))
        }
        return new Response(null, {
          status: 405,
          headers: { Allow: 'GET, POST' }
        })
      } catch (error) {
        return oauthJson(
          {
            error: error instanceof OAuthError ? error.code : 'invalid_request'
          },
          error instanceof OAuthError ? error.status : 400
        )
      }
    },
    { maxBodyBytes: 16_384, authorize: async (request) => hostGuard(request) }
  )
  mount(`/oauth/${endpointId}/token`, 'POST', async (request) => {
    const form = await formBody(request)
    if (request.headers.has('authorization') || form.has('client_secret')) {
      throw new OAuthError('invalid_client', 401)
    }
    clients.resolve(form.get('client_id') ?? '')
    if (form.get('grant_type') === 'authorization_code') {
      return tokens.code(form)
    }
    if (form.get('grant_type') === 'refresh_token') {
      return tokens.refresh(form)
    }
    throw new OAuthError('unsupported_grant_type')
  })

  return async (request): Promise<Response | undefined> => {
    // An in-process credential rotation invalidates the old server until it is restarted.
    const valid =
      equalSecret(secret, resolveAgentSecret(config.mcp.token)) &&
      (await tokens.verify(request))

    return valid
      ? undefined
      : new Response(null, {
          status: 401,
          headers: {
            'Cache-Control': 'no-store',
            'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`
          }
        })
  }
}
