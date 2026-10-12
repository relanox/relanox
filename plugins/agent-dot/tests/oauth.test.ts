import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDotAgentPlugin } from '../src/index.js'
import { fixture, dotMcp } from './fixture.js'
import { authorizeWithSdk } from './oauth-sdk.js'
import {
  approve,
  authorizationUrl,
  begin,
  exchange,
  issuer,
  origin,
  password,
  postForm,
  refresh,
  register,
  resource,
  tokenResponse
} from './oauth-peer.js'

let runtime: Awaited<ReturnType<typeof fixture>> | undefined

beforeEach(() => {
  vi.stubEnv('AGENT_TEST_TOKEN_0', password)
  vi.stubEnv('AGENT_TEST_TOKEN_1', password)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await runtime?.close()
  runtime = undefined
})

async function start(): Promise<Awaited<ReturnType<typeof fixture>>> {
  runtime = await fixture('dot', createDotAgentPlugin(), [
    { mcp: dotMcp() },
    { mcp: dotMcp('AGENT_TEST_TOKEN_1') }
  ])
  return runtime
}

it('discovers endpoint OAuth metadata and authenticates an SDK client after owner consent', async () => {
  const f = await start()
  const challenge = await f.core.fetch(new Request(resource))
  expect(challenge.status).toBe(401)
  expect(challenge.headers.get('www-authenticate')).toBe(
    'Bearer resource_metadata="https://relanox.test/.well-known/oauth-protected-resource/agents/dot/mcp/endpoint0", scope="relanox"'
  )

  const metadata = await f.core.fetch(
    new Request(
      `${origin}/.well-known/oauth-protected-resource/agents/dot/mcp/endpoint0`
    )
  )

  expect(await metadata.json()).toMatchObject({
    resource,
    authorization_servers: [issuer]
  })

  const server = await f.core.fetch(
    new Request(
      `${origin}/.well-known/oauth-authorization-server/agents/dot/oauth/endpoint0`
    )
  )

  expect(await server.json()).toMatchObject({
    issuer,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true
  })
  const tokens = await authorizeWithSdk(f.core)
  const received = await f.ingest()
  const client = await f.client(tokens.access_token)
  const tools = (await client.listTools()).tools
  expect(tools.map((tool) => tool.name)).toContain('relanox_send_message')
  for (const { _meta: toolMetadata } of tools) {
    expect(toolMetadata?.securitySchemes).toEqual([
      { type: 'oauth2', scopes: ['relanox'] }
    ])
  }

  const queued = await client.callTool({
    name: 'relanox_send_message',
    arguments: { replyTo: received.requestId, text: 'OAuth reply' }
  })

  expect(queued.isError).toBe(false)
  await f.core.processDue()
  expect(f.sent).toMatchObject([
    {
      chunk: { text: 'OAuth reply' },
      target: { chatId: 'chat0', replyToId: 'original' }
    }
  ])

  const staticToken = await f.core.fetch(
    new Request(resource, { headers: { Authorization: `Bearer ${password}` } })
  )

  expect(staticToken.status).toBe(401)

  const otherEndpoint = await f.core.fetch(
    new Request(`${origin}/agents/dot/mcp/endpoint1`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })
  )

  expect(otherEndpoint.status).toBe(401)
})

it('binds codes to PKCE, client, redirect and resource and consumes each code once', async () => {
  const f = await start()
  const pending = await begin(f.core)
  const code = await approve(f.core, pending)
  const otherClient = await register(f.core, { client_name: 'Second client' })
  for (const values of [
    { code_verifier: 'x'.repeat(43) },
    { client_id: otherClient },
    { redirect_uri: 'https://chatgpt.com/connector/oauth/another-connection' },
    { resource: `${origin}/agents/dot/mcp/endpoint1` }
  ]) {
    expect((await exchange(f.core, pending, code, values)).status).toBe(400)
  }

  const responses = await Promise.all([
    exchange(f.core, pending, code),
    exchange(f.core, pending, code)
  ])

  expect(
    responses.map((response) => response.status).toSorted((a, b) => a - b)
  ).toEqual([200, 400])
})

it('requires the owner password and same-browser consent, and supports cancellation', async () => {
  const f = await start()
  const pending = await begin(f.core)
  const values = { request: pending.request, password, decision: 'allow' }
  expect(
    (await postForm(f.core, `${issuer}/authorize`, values, { Origin: origin }))
      .status
  ).toBe(403)
  expect(
    (
      await postForm(f.core, `${issuer}/authorize`, values, {
        Origin: 'https://other.test',
        Cookie: pending.cookie
      })
    ).status
  ).toBe(403)
  expect(
    (
      await postForm(
        f.core,
        `${issuer}/authorize`,
        { ...values, password: 'wrong' },
        { Origin: origin, Cookie: pending.cookie }
      )
    ).status
  ).toBe(403)

  const cancelled = await postForm(
    f.core,
    `${issuer}/authorize`,
    { request: pending.request, decision: 'deny' },
    { Origin: origin, Cookie: pending.cookie }
  )

  expect(cancelled.status).toBe(303)

  const location = new URL(
    cancelled.headers.get('location') ?? 'https://invalid.test'
  )

  expect(location.searchParams.get('error')).toBe('access_denied')
  expect(location.searchParams.get('iss')).toBe(issuer)
  expect(location.searchParams.get('state')).toBe('state-from-native-client')
  expect(location.searchParams.has('code')).toBe(false)
  expect(
    (
      await postForm(f.core, `${issuer}/authorize`, values, {
        Origin: origin,
        Cookie: pending.cookie
      })
    ).status
  ).toBe(400)
})

it('restores OAuth credentials from SQLite and rotates refresh tokens with family revocation on reuse', async () => {
  const f = await start()
  const pending = await begin(f.core)

  const tokens = await tokenResponse(
    await exchange(f.core, pending, await approve(f.core, pending))
  )

  await f.reopen(createDotAgentPlugin())
  const restored = await f.client(tokens.access_token)
  expect((await restored.listTools()).tools).not.toHaveLength(0)

  const rotated = await tokenResponse(
    await refresh(f.core, pending, tokens.refresh_token, {
      scope: 'offline_access relanox'
    })
  )

  expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
  expect(rotated.access_token).not.toBe(tokens.access_token)
  const client = await f.client(rotated.access_token)
  expect((await client.listTools()).tools).not.toHaveLength(0)
  expect((await refresh(f.core, pending, tokens.refresh_token)).status).toBe(
    400
  )
  expect((await refresh(f.core, pending, rotated.refresh_token)).status).toBe(
    400
  )
  for (const token of [tokens.access_token, rotated.access_token]) {
    expect(
      (
        await f.core.fetch(
          new Request(resource, {
            headers: { Authorization: `Bearer ${token}` }
          })
        )
      ).status
    ).toBe(401)
  }
})

it('rejects expired access tokens and codes, while a valid refresh can renew access', async () => {
  const f = await start()
  const pending = await begin(f.core)

  const tokens = await tokenResponse(
    await exchange(f.core, pending, await approve(f.core, pending))
  )

  const next = await begin(f.core)
  const code = await approve(f.core, next)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_001)
  expect(
    (
      await f.core.fetch(
        new Request(resource, {
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        })
      )
    ).status
  ).toBe(401)
  expect((await exchange(f.core, next, code)).status).toBe(400)

  const renewed = await tokenResponse(
    await refresh(f.core, pending, tokens.refresh_token)
  )

  const client = await f.client(renewed.access_token)
  expect((await client.listTools()).tools).not.toHaveLength(0)
  vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 86_400_000)
  expect((await refresh(f.core, pending, renewed.refresh_token)).status).toBe(
    400
  )
})

it('rejects arbitrary redirects, altered registrations, missing PKCE and cross-endpoint client IDs', async () => {
  const f = await start()

  const invalid = await f.core.fetch(
    new Request(`${issuer}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://attacker.test/callback']
      })
    })
  )

  expect(invalid.status).toBe(400)
  const client = await register(f.core)

  const values = [
    { redirect_uri: 'https://attacker.test/callback' },
    { resource: `${origin}/agents/dot/mcp/endpoint1` },
    { code_challenge_method: 'plain' },
    { code_challenge: '' },
    { scope: 'admin' },
    { client_id: `${client.slice(0, -8)}tampered` }
  ]

  for (const value of values) {
    const response = await f.core.fetch(
      new Request(authorizationUrl(client, 'v'.repeat(43), value))
    )

    expect([400, 401]).toContain(response.status)
    expect(response.headers.has('location')).toBe(false)
  }

  const otherUrl = authorizationUrl(client, 'v'.repeat(43), {
    resource: `${origin}/agents/dot/mcp/endpoint1`
  })

  otherUrl.pathname = '/agents/dot/oauth/endpoint1/authorize'
  expect((await f.core.fetch(new Request(otherUrl))).status).toBe(401)
})

it('keeps discovery and registration scoped to the deployment host and bounded request bodies', async () => {
  const f = await start()

  const wrongHost = await f.core.fetch(
    new Request(`${issuer}/register`, {
      method: 'POST',
      headers: { Host: 'attacker.test', 'Content-Type': 'application/json' },
      body: '{}'
    })
  )

  expect(wrongHost.status).toBe(403)

  const oversized = await f.core.fetch(
    new Request(`${issuer}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'x'.repeat(20_000) })
    })
  )

  expect(oversized.status).toBe(413)

  const response = await f.core.fetch(
    new Request(
      `${origin}/.well-known/oauth-authorization-server/agents/dot/oauth/endpoint1`
    )
  )

  expect(
    z.object({ issuer: z.string() }).parse(await response.json()).issuer
  ).toBe(`${origin}/agents/dot/oauth/endpoint1`)
})

it('revokes old OAuth credentials when the configured password changes and the server restarts', async () => {
  const f = await start()
  const pending = await begin(f.core)

  const tokens = await tokenResponse(
    await exchange(f.core, pending, await approve(f.core, pending))
  )

  vi.stubEnv(
    'AGENT_TEST_TOKEN_0',
    'new-owner-password-with-at-least-32-characters'
  )
  await f.reopen(createDotAgentPlugin())
  expect(
    (
      await f.core.fetch(
        new Request(resource, {
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        })
      )
    ).status
  ).toBe(401)
  expect((await refresh(f.core, pending, tokens.refresh_token)).status).toBe(
    401
  )
})
