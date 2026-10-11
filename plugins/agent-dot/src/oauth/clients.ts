import { createHmac } from 'node:crypto'
import { equalSecret } from '@relanox/agent-mcp'
import { z } from 'zod'
import {
  clientSchema,
  lifetime,
  nativeRedirect,
  OAuthError
} from './protocol.js'
import type { OAuthClient } from './protocol.js'

const metadataSchema = clientSchema.omit({ client_id: true }).extend({
  client_name: z.string().min(1).max(100).default('ChatGPT'),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .max(2)
    .default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).length(1).default(['code'])
})

const registrationSchema = z.object({
  metadata: metadataSchema,
  expiresAt: z.number().int()
})

export type ClientRegistry = {
  register(input: unknown): OAuthClient
  resolve(clientId: string): OAuthClient
}

/** Signed public-client metadata avoids allocating persistent state on unauthenticated DCR requests. */
export function createClientRegistry(
  secret: string,
  resource: string
): ClientRegistry {
  const sign = (payload: string): string =>
    createHmac('sha256', secret)
      .update(`relanox-oauth-client:${resource}:${payload}`)
      .digest('base64url')

  function register(input: unknown): OAuthClient {
    const parsed = metadataSchema.safeParse(input)
    if (
      !parsed.success ||
      !parsed.data.redirect_uris.every(nativeRedirect) ||
      !parsed.data.grant_types.includes('authorization_code')
    ) {
      throw new OAuthError('invalid_client_metadata')
    }

    const payload = Buffer.from(
      JSON.stringify({
        metadata: parsed.data,
        expiresAt: Date.now() + lifetime.client
      })
    ).toString('base64url')

    if (payload.length > 1800) {
      throw new OAuthError('invalid_client_metadata')
    }
    return { ...parsed.data, client_id: `${payload}.${sign(payload)}` }
  }

  function resolve(clientId: string): OAuthClient {
    const parts = clientId.split('.')
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1] ||
      parts[0].length > 1800 ||
      !equalSecret(sign(parts[0]), parts[1])
    ) {
      throw new OAuthError('invalid_client', 401)
    }

    const parsed = registrationSchema.safeParse(
      JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    )

    if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
      throw new OAuthError('invalid_client', 401)
    }
    return { ...parsed.data.metadata, client_id: clientId }
  }

  return { register, resolve }
}
