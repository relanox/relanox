import { auth } from '@modelcontextprotocol/client'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens
} from '@modelcontextprotocol/client'
import type { CoreRuntime } from '@relanox/core'
import { expect } from 'vitest'
import {
  issuer,
  origin,
  password,
  postForm,
  redirectUri,
  resource
} from './oauth-peer.js'

/** Only the external client's credential storage and browser consent; SDK drives discovery, DCR and PKCE. */
export async function authorizeWithSdk(
  core: CoreRuntime
): Promise<StoredOAuthTokens> {
  let client: StoredOAuthClientInformation | undefined
  let tokens: StoredOAuthTokens | undefined
  let discovery: OAuthDiscoveryState | undefined
  let verifier = ''
  let redirect: URL | undefined

  const provider: OAuthClientProvider = {
    redirectUrl: redirectUri,
    clientMetadata: {
      client_name: 'ChatGPT SDK test',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    },
    clientInformation: () => client,
    saveClientInformation(value) {
      client = value
    },
    tokens: () => tokens,
    saveTokens(value) {
      tokens = value
    },
    saveCodeVerifier(value) {
      verifier = value
    },
    codeVerifier: () => verifier,
    redirectToAuthorization(url) {
      redirect = url
    },
    saveDiscoveryState(value) {
      discovery = value
    },
    discoveryState: () => discovery
  }

  const fetchFn: typeof fetch = async (input, init) =>
    core.fetch(new Request(input, init))

  expect(await auth(provider, { serverUrl: resource, fetchFn })).toBe(
    'REDIRECT'
  )
  if (!redirect) {
    throw new Error('missing_sdk_redirect')
  }
  const page = await core.fetch(new Request(redirect))
  expect(page.status).toBe(200)

  const request = /name="request" value="(?<request>[A-Za-z0-9_-]+)"/u.exec(
    await page.text()
  )?.groups?.request

  const cookie = page.headers.get('set-cookie')?.split(';')[0]
  if (!request || !cookie) {
    throw new Error('missing_consent_form')
  }

  const consent = await postForm(
    core,
    `${issuer}/authorize`,
    { request, password, decision: 'allow' },
    { Origin: origin, Cookie: cookie }
  )

  expect(consent.status).toBe(303)

  const callback = new URL(
    consent.headers.get('location') ?? 'https://invalid.test'
  )

  const code = callback.searchParams.get('code')
  const responseIssuer = callback.searchParams.get('iss')
  if (!code || !responseIssuer) {
    throw new Error('missing_authorization_response')
  }
  expect(
    await auth(provider, {
      serverUrl: resource,
      fetchFn,
      authorizationCode: code,
      iss: responseIssuer
    })
  ).toBe('AUTHORIZED')
  if (!tokens) {
    throw new Error('missing_sdk_tokens')
  }
  expect(tokens.token_type).toBe('Bearer')
  expect(tokens.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  const firstRefresh = tokens.refresh_token
  expect(await auth(provider, { serverUrl: resource, fetchFn })).toBe(
    'AUTHORIZED'
  )
  expect(tokens.refresh_token).not.toBe(firstRefresh)
  return tokens
}
