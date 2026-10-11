import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { callbackUrl, isPublicAddress } from '../src/callback.js'
import { createDotAgentPlugin } from '../src/index.js'
import { guard } from '../src/mcp.js'
import { fixture, mcp, parseWire, peer } from './fixture.js'
import type { Traffic } from './fixture.js'

const signingKey = `whsec_${Buffer.alloc(32, 17).toString('base64')}`
const newKey = `whsec_${Buffer.alloc(32, 25).toString('base64')}`
const cleanups: (() => Promise<void>)[] = []
const stringValue: unknown = expect.any(String)
beforeEach(() => {
  process.env.AGENT_TEST_TOKEN_0 = 'secret-0'
  process.env.AGENT_TEST_TOKEN_1 = 'secret-1'
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    cleanups
      .splice(0)
      .toReversed()
      .map((cleanup) => cleanup())
  )
  delete process.env.AGENT_TEST_TOKEN_0
  delete process.env.AGENT_TEST_TOKEN_1
})

function verify(traffic: Traffic | undefined, secret = signingKey) {
  if (traffic === undefined) {
    throw new Error('missing_callback_traffic')
  }
  const bytes = `${String(traffic.headers['webhook-id'])}.${String(traffic.headers['webhook-timestamp'])}.${traffic.body}`

  const signature = `v1,${createHmac(
    'sha256',
    Buffer.from(secret.slice(6), 'base64')
  )
    .update(bytes)
    .digest('base64')}`

  expect(String(traffic.headers['webhook-signature']).split(' ')).toContain(
    signature
  )
}

const subResult = z
  .strictObject({
    id: z.string(),
    refreshBefore: z.string(),
    cursor: z.null(),
    truncated: z.boolean()
  })
  .loose()

const callbackBody = z.looseObject({
  type: z.string().optional(),
  challenge: z.string().optional()
})

function subscribe(url: string, secret = signingKey, ttlMs = 1000) {
  return {
    method: 'events/subscribe',
    params: {
      name: 'relanox.message_available',
      arguments: {},
      delivery: { mode: 'webhook', url, secret },
      ttlMs
    }
  }
}

async function setup(
  reply: Parameters<typeof peer>[0] = (record: Traffic) => ({
    status: 200,
    body: JSON.stringify({
      challenge: callbackBody.parse(parseWire(record.body)).challenge
    })
  }),
  two = false
) {
  const receiver = await peer(reply)
  cleanups.push(receiver.close)

  const config = {
    mcp: mcp(),
    callback: {
      allowedOrigins: [receiver.origin],
      transport: 'loopback-http',
      timeoutMs: 500
    },
    subscriptionTtlMs: 60_000,
    rotationWindowMs: 1000
  }

  const plugin = createDotAgentPlugin()

  const fx = await fixture(
    'dot',
    plugin,
    two ? [config, { ...config, mcp: mcp('AGENT_TEST_TOKEN_1') }] : [config]
  )

  cleanups.push(() => fx.close())
  return { receiver, plugin, fx, url: `${receiver.origin}/callback` }
}

describe('dot MCP Events and tools', () => {
  it('accepts request metadata on Events methods without changing subscription identity', async () => {
    const { fx, url } = await setup()
    const client = await fx.client()

    const metadata = {
      progressToken: 'subscription-progress',
      'com.example/correlation': 'trace'
    }

    const catalog = await client.request(
      { method: 'events/list', params: { _meta: metadata } },
      z.object({ events: z.array(z.object({ name: z.string() })) })
    )

    expect(catalog.events.map((event) => event.name)).toEqual([
      'relanox.message_available'
    ])
    const request = subscribe(url, signingKey, 10_000)

    const created = await client.request(
      { ...request, params: { ...request.params, _meta: metadata } },
      subResult
    )

    expect((await client.request(request, subResult)).id).toBe(created.id)
    await client.request(
      {
        method: 'events/unsubscribe',
        params: {
          name: 'relanox.message_available',
          arguments: {},
          delivery: { mode: 'webhook', url },
          _meta: metadata
        }
      },
      z.object({})
    )
    expect(
      await fx.storage.listState(
        { pluginId: 'agent-dot', ownerId: 'dot' },
        { prefix: 'subscriptions/', limit: 100 }
      )
    ).toEqual([])
  })

  it('rejects an already-aborted request without waiting for its stalled body', async () => {
    const controller = new AbortController()
    controller.abort()

    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-0' },
      body: new ReadableStream<Uint8Array>(),
      duplex: 'half',
      signal: controller.signal
    }

    const response = await guard(
      new Request('http://relanox.test/agents/dot/mcp/endpoint0', init),
      mcp()
    )

    if (!(response instanceof Response)) {
      throw new Error('aborted_body_accepted')
    }
    expect(response.status).toBe(408)
    expect(await response.json()).toEqual({ error: 'request_timeout' })
  })

  it('advertises Events on the discovery wire and strictly authenticates endpoint-scoped tools', async () => {
    const { fx } = await setup(undefined, true)
    const first = await fx.ingest()
    const other = await fx.ingest(1, 'other', 'event-2')
    const client = await fx.client()
    expect(fx.wire[0]).toMatchObject({
      result: {
        capabilities: { tools: {}, events: {} },
        supportedVersions: ['2026-07-28']
      }
    })
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'relanox_list_pending',
      'relanox_claim',
      'relanox_complete',
      'relanox_fail',
      'relanox_media_transfer',
      'relanox_read_media'
    ])
    expect(tools.tools.map((tool) => tool.annotations?.readOnlyHint)).toEqual([
      true,
      false,
      false,
      false,
      true,
      true
    ])

    const pending = await client.callTool({
      name: 'relanox_list_pending',
      arguments: {}
    })

    expect(pending.structuredContent).toEqual({
      requests: [
        {
          requestId: first.requestId,
          text: '中文\nsecond line',
          context: { thread: 'protocol-context' },
          source: { channel: 'telegram', eventId: 'event-1' }
        }
      ]
    })

    const denied = await client.callTool({
      name: 'relanox_claim',
      arguments: { requestId: other.requestId, claimKey: 'run-1' }
    })

    expect(denied).toMatchObject({
      isError: true,
      structuredContent: { status: 'not_found' }
    })
    expect(
      await client.callTool({
        name: 'relanox_list_pending',
        arguments: { endpointIds: ['endpoint1'] }
      })
    ).toMatchObject({ isError: true })

    const claim = await client.callTool({
      name: 'relanox_claim',
      arguments: { requestId: first.requestId, claimKey: 'run-1' }
    })

    expect(claim).toMatchObject({
      isError: false,
      structuredContent: { status: 'claimed', replay: false }
    })

    const token = z
      .object({ claimToken: z.string() })
      .parse(claim.structuredContent).claimToken

    const completed = await client.callTool({
      name: 'relanox_complete',
      arguments: {
        requestId: first.requestId,
        claimToken: token,
        resultId: 'result-1',
        text: 'done'
      }
    })

    expect(completed).toMatchObject({
      isError: false,
      structuredContent: { status: 'completed', replay: false }
    })
    expect(
      await client.callTool({
        name: 'relanox_complete',
        arguments: {
          requestId: first.requestId,
          claimToken: token,
          resultId: 'result-1',
          text: 'done'
        }
      })
    ).toMatchObject({ structuredContent: { replay: true } })
    await fx.core.processDue()
    expect(fx.sent).toHaveLength(1)
    for (const [headers, expected] of [
      [{}, 401],
      [{ Authorization: 'Bearer wrong' }, 401],
      [{ Authorization: 'Bearer secret-0', Origin: 'https://evil.test' }, 403],
      [{ Authorization: 'Bearer secret-0', Host: 'evil.test' }, 403]
    ] as const) {
      expect(
        (
          await fx.core.fetch(
            new Request('http://relanox.test/agents/dot/mcp/endpoint0', {
              method: 'POST',
              headers,
              body: '{}'
            })
          )
        ).status
      ).toBe(expected)
    }
    expect(
      (
        await fx.core.fetch(
          new Request('http://relanox.test/agents/dot/mcp/endpoint0', {
            method: 'POST',
            headers: { Authorization: 'Bearer secret-0' },
            body: 'x'.repeat(1_048_577)
          })
        )
      ).status
    ).toBe(413)
  })

  it('persists verification and subscriptions, renews identity, rotates signatures and stops/expirs delivery', async () => {
    const { fx, receiver, url } = await setup()
    const client = await fx.client()
    const first = await client.request(subscribe(url), subResult)
    expect(first).toMatchObject({ cursor: null, truncated: false })
    expect(receiver.traffic).toHaveLength(1)
    verify(receiver.traffic[0])
    expect(parseWire(receiver.traffic[0]?.body ?? '')).toMatchObject({
      type: 'verification',
      challenge: stringValue
    })

    const renewed = await client.request(
      subscribe(url, signingKey, 10_000),
      subResult
    )

    expect(renewed.id).toBe(first.id)
    expect(Date.parse(renewed.refreshBefore)).toBeGreaterThan(
      Date.parse(first.refreshBefore)
    )
    expect(receiver.traffic).toHaveLength(1)
    const received = await fx.ingest()
    await fx.reopen(createDotAgentPlugin())
    await fx.core.processDue()
    expect(receiver.traffic).toHaveLength(2)
    const event = parseWire(receiver.traffic[1]?.body ?? '')
    expect(event).toEqual({
      eventId: `evt_${received.requestId}`,
      name: 'relanox.message_available',
      timestamp: stringValue,
      data: { requestId: received.requestId },
      cursor: null
    })
    verify(receiver.traffic[1])
    expect(receiver.traffic[1]?.headers['x-mcp-subscription-id']).toBe(first.id)
    const afterRestart = await fx.client()
    expect(
      (await afterRestart.request(subscribe(url, newKey, 10_000), subResult)).id
    ).toBe(first.id)

    const state = await fx.storage.listState(
      { pluginId: 'agent-dot', ownerId: 'dot' },
      { prefix: 'subscriptions/', limit: 100 }
    )

    expect(state).toHaveLength(1)
    const request = (await fx.storage.getInbound(received.requestId))?.snapshot
    if (!request) {
      throw new Error('missing_request')
    }
    expect(
      await fx.agent.dispatch({
        request,
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'accepted' })
    const rotated = receiver.traffic.at(-1) as Traffic
    verify(rotated, newKey)
    verify(rotated, signingKey)

    const ended = await afterRestart.request(
      {
        method: 'events/unsubscribe',
        params: {
          name: 'relanox.message_available',
          arguments: {},
          delivery: { mode: 'webhook', url }
        }
      },
      z.object({})
    )

    expect(ended).toMatchObject({})
    const before = receiver.traffic.length
    expect(
      await fx.agent.dispatch({
        request,
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'retryable', errorCode: 'dot_no_active_subscription' })
    expect(receiver.traffic).toHaveLength(before)
    await afterRestart.request(subscribe(url, newKey, 1000), subResult)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
    expect(
      await fx.agent.dispatch({
        request,
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'retryable', errorCode: 'dot_no_active_subscription' })
    expect(receiver.traffic).toHaveLength(before + 1)
  })

  it('refuses failed challenges and callback SSRF without activating state', async () => {
    const { fx, url } = await setup(() => ({
      status: 200,
      body: '{"challenge":"wrong"}'
    }))

    const client = await fx.client()
    await expect(
      client.request(subscribe(url), subResult)
    ).rejects.toMatchObject({
      code: -32_015,
      data: { reason: 'challenge_failed' }
    })
    await expect(
      client.request(subscribe('http://127.0.0.1:1/private'), subResult)
    ).rejects.toMatchObject({
      code: -32_015,
      data: { reason: 'forbidden_destination' }
    })
    await expect(
      client.request(subscribe(url, 'whsec_YQ=='), subResult)
    ).rejects.toThrow()
    expect(
      await fx.storage.listState(
        { pluginId: 'agent-dot', ownerId: 'dot' },
        { prefix: 'subscriptions/', limit: 100 }
      )
    ).toHaveLength(0)
    const receipt = await fx.ingest()
    await fx.core.processDue()
    expect(
      (await fx.storage.getInbound(receipt.requestId))?.dispatch.errorCode
    ).toBe('dot_no_active_subscription')
  })

  it.each([
    [200, 'accepted', undefined],
    [302, 'rejected', 'dot_callback_http_302'],
    [410, 'rejected', 'dot_callback_http_410'],
    [413, 'rejected', 'dot_callback_http_413'],
    [408, 'unknown', 'dot_callback_http_408'],
    [429, 'retryable', 'dot_callback_http_429'],
    [503, 'retryable', 'dot_callback_http_503']
  ] as const)(
    'classifies callback HTTP %i as %s while preserving event identity',
    async (status, outcome, errorCode) => {
      const { fx, url, receiver } = await setup((record) => {
        const body = callbackBody.parse(parseWire(record.body))
        return body.type === 'verification'
          ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) }
          : { status, headers: { Location: 'http://127.0.0.1:1/private' } }
      })

      const client = await fx.client()
      const subscription = await client.request(subscribe(url), subResult)
      const receipt = await fx.ingest()
      const request = (await fx.storage.getInbound(receipt.requestId))?.snapshot
      if (!request) {
        throw new Error('missing_request')
      }
      expect(
        await fx.agent.dispatch({
          request,
          signal: new AbortController().signal
        })
      ).toEqual({ status: outcome, ...(errorCode ? { errorCode } : {}) })
      const first = receiver.traffic[1]
      expect(parseWire(first?.body ?? '')).toEqual({
        eventId: `evt_${receipt.requestId}`,
        name: 'relanox.message_available',
        timestamp: new Date(request.acceptedAt).toISOString(),
        data: { requestId: receipt.requestId },
        cursor: null
      })
      expect(first?.headers['x-mcp-subscription-id']).toBe(subscription.id)
      verify(first)
      if (status === 410) {
        expect(
          await fx.agent.dispatch({
            request,
            signal: new AbortController().signal
          })
        ).toEqual({
          status: 'retryable',
          errorCode: 'dot_no_active_subscription'
        })
        expect(receiver.traffic).toHaveLength(2)
      } else {
        expect(
          await fx.agent.dispatch({
            request,
            signal: new AbortController().signal
          })
        ).toEqual({ status: outcome, ...(errorCode ? { errorCode } : {}) })
        expect(receiver.traffic[2]?.headers['webhook-id']).toBe(
          `evt_${receipt.requestId}`
        )
        expect(receiver.traffic[2]?.body).toBe(first?.body)
      }
    }
  )

  it.each([
    [200, 'accepted', undefined],
    [410, 'rejected', 'dot_callback_http_410'],
    [503, 'retryable', 'dot_callback_http_503']
  ] as const)(
    'uses event HTTP %i acknowledgement without consuming its oversized response body',
    async (status, outcome, errorCode) => {
      const { fx, url } = await setup((record) => {
        const body = callbackBody.parse(parseWire(record.body))
        return body.type === 'verification'
          ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) }
          : { status, body: 'x'.repeat(20_000) }
      })

      const client = await fx.client()
      await client.request(subscribe(url, signingKey, 10_000), subResult)
      const receipt = await fx.ingest()
      const request = (await fx.storage.getInbound(receipt.requestId))?.snapshot
      if (!request) {
        throw new Error('missing_request')
      }
      expect(
        await fx.agent.dispatch({
          request,
          signal: new AbortController().signal
        })
      ).toEqual({
        status: outcome,
        ...(errorCode ? { errorCode } : {})
      })
      expect(
        await fx.storage.listState(
          { pluginId: 'agent-dot', ownerId: 'dot' },
          { prefix: 'subscriptions/', limit: 100 }
        )
      ).toHaveLength(status === 410 ? 0 : 1)
    }
  )

  it('cannot unsubscribe another owner and stops signing with a rotated old key after overlap', async () => {
    const { fx, url, receiver } = await setup(undefined, true)
    const first = await fx.client()
    const second = await fx.client('secret-1', 1)

    const firstSub = await first.request(
      subscribe(url, signingKey, 10_000),
      subResult
    )

    await second.request(
      {
        method: 'events/unsubscribe',
        params: {
          name: 'relanox.message_available',
          arguments: {},
          delivery: { mode: 'webhook', url }
        }
      },
      z.object({})
    )
    const receipt = await fx.ingest()
    const request = (await fx.storage.getInbound(receipt.requestId))?.snapshot
    if (!request) {
      throw new Error('missing_request')
    }
    expect(
      await fx.agent.dispatch({
        request,
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'accepted' })
    expect(receiver.traffic.at(-1)?.headers['x-mcp-subscription-id']).toBe(
      firstSub.id
    )
    await first.request(subscribe(url, newKey, 10_000), subResult)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 1500)
    expect(
      await fx.agent.dispatch({
        request,
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'accepted' })
    verify(receiver.traffic.at(-1), newKey)
    expect(
      String(receiver.traffic.at(-1)?.headers['webhook-signature']).split(' ')
    ).toHaveLength(1)
  })

  it.each(['renewed', 'recreated'] as const)(
    'a 410 response cannot erase a subscription %s while delivery was in flight',
    async (mode) => {
      let release: (() => void) | undefined
      let observed: (() => void) | undefined

      const received = new Promise<void>((resolve) => {
        observed = resolve
      })

      const held = new Promise<void>((resolve) => {
        release = resolve
      })

      const { fx, url } = await setup(async (record) => {
        const body = callbackBody.parse(parseWire(record.body))
        if (body.type === 'verification') {
          return {
            status: 200,
            body: JSON.stringify({ challenge: body.challenge })
          }
        }
        observed?.()
        await held
        return { status: 410 }
      })

      const client = await fx.client()

      const subscription = await client.request(
        subscribe(url, signingKey, 10_000),
        subResult
      )

      const receipt = await fx.ingest()
      const request = (await fx.storage.getInbound(receipt.requestId))?.snapshot
      if (!request) {
        throw new Error('missing_request')
      }

      const delivery = fx.agent.dispatch({
        request,
        signal: new AbortController().signal
      })

      await received
      if (mode === 'recreated') {
        await client.request(
          {
            method: 'events/unsubscribe',
            params: {
              name: 'relanox.message_available',
              arguments: {},
              delivery: { mode: 'webhook', url }
            }
          },
          z.object({})
        )
      }
      expect(
        (await client.request(subscribe(url, signingKey, 10_000), subResult)).id
      ).toBe(subscription.id)
      release?.()
      expect(await delivery).toEqual({
        status: 'rejected',
        errorCode: 'dot_callback_http_410'
      })
      expect(
        await fx.storage.listState(
          { pluginId: 'agent-dot', ownerId: 'dot' },
          { prefix: 'subscriptions/', limit: 100 }
        )
      ).toHaveLength(1)
    }
  )

  it.each([
    '127.0.0.1',
    '10.1.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
    '2002:7f00:1::1'
  ])('rejects nonpublic callback address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it('accepts public addresses while enforcing HTTPS and exact callback origins', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
    expect(() =>
      callbackUrl('http://receiver.test/callback', {
        allowedOrigins: ['http://receiver.test'],
        transport: 'public-https',
        timeoutMs: 1000
      })
    ).toThrow()
    expect(() =>
      callbackUrl('https://receiver.test.evil.test/callback', {
        allowedOrigins: ['https://receiver.test'],
        transport: 'public-https',
        timeoutMs: 1000
      })
    ).toThrow()
  })
})
