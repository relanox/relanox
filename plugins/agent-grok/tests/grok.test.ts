import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fixture, mcp, parseWire, peer } from '../../agent-dot/tests/fixture.js'
import { createGrokAgentPlugin } from '../src/index.js'
import { guard } from '@relanox/agent-mcp'

const cleanups: (() => Promise<void>)[] = []
const stringValue: unknown = expect.any(String)
beforeEach(() => {
  process.env.AGENT_TEST_TOKEN_0 = 'secret-0'
  process.env.AGENT_TEST_TOKEN_1 = 'secret-1'
  process.env.GROK_TEST_AUTH = 'Bearer routine-credential'
})
afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .toReversed()
      .map(async (cleanup) => cleanup())
  )
  for (const name of [
    'AGENT_TEST_TOKEN_0',
    'AGENT_TEST_TOKEN_1',
    'GROK_TEST_AUTH',
    'GROK_TEST_URL'
  ]) {
    delete process.env[name]
  }
})

async function setup(
  status = 200,
  headers: Record<string, string> = {},
  timeoutMs = 1000
): Promise<{
  receiver: Awaited<ReturnType<typeof peer>>
  plugin: ReturnType<typeof createGrokAgentPlugin>
  fx: Awaited<ReturnType<typeof fixture>>
}> {
  const receiver = await peer(() => ({ status, headers }))
  cleanups.push(receiver.close)
  process.env.GROK_TEST_URL = `${receiver.origin}/user-supplied-routine`

  const config = {
    mcp: mcp(),
    routineUrl: { env: 'GROK_TEST_URL' },
    routineAuthorization: { env: 'GROK_TEST_AUTH' },
    routineTransport: 'loopback-http',
    timeoutMs,
    maxBodyBytes: 1_048_576
  }

  const plugin = createGrokAgentPlugin()

  const fx = await fixture('grok', plugin, [
    config,
    { ...config, mcp: mcp('AGENT_TEST_TOKEN_1') }
  ])

  cleanups.push(async () => fx.close())
  return { receiver, plugin, fx }
}

describe('grok configured Routine and scoped MCP', () => {
  it('includes stored media metadata in the hosted Routine without serializing binary bytes', async () => {
    const { fx, receiver } = await setup()
    await fx.ingest(0, 'inspect the image', 'routine-media', [
      {
        kind: 'image',
        mimeType: 'image/png',
        fileName: 'routine.png',
        data: new Uint8Array([137, 80, 78, 71])
      }
    ])
    await fx.core.processDue()

    const outer = z
      .looseObject({ content: z.string() })
      .parse(parseWire(receiver.traffic[0]?.body ?? ''))

    expect(parseWire(outer.content)).toMatchObject({
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/png',
          fileName: 'routine.png',
          size: 4
        }
      ]
    })

    const payload = z
      .looseObject({ attachments: z.array(z.record(z.string(), z.unknown())) })
      .parse(parseWire(outer.content))

    expect(payload.attachments[0]).not.toHaveProperty('data')
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
      new Request('http://relanox.test/agents/grok/mcp/endpoint0', init),
      mcp()
    )

    if (!(response instanceof Response)) {
      throw new Error('aborted_body_accepted')
    }
    expect(response.status).toBe(408)
    expect(await response.json()).toEqual({ error: 'request_timeout' })
  })

  it.each([false, true])(
    'transmits exact text and completes through the SDK %s modern client',
    async (modern) => {
      const { fx, receiver } = await setup()
      const receipt = await fx.ingest()
      await fx.core.processDue()
      expect(receiver.traffic).toHaveLength(1)
      const trigger = receiver.traffic[0]
      expect(trigger?.url).toBe('/user-supplied-routine')
      expect(trigger?.headers.authorization).toBe('Bearer routine-credential')
      expect(trigger?.headers['content-type']).toBe('application/json')
      const posted = parseWire(trigger?.body ?? '')
      expect(posted).toEqual({
        content: JSON.stringify({
          requestId: receipt.requestId,
          text: '中文\nsecond line',
          context: { thread: 'protocol-context' },
          source: { channel: 'telegram', eventId: 'event-1' }
        }),
        source: 'relanox',
        sentAt: stringValue
      })
      expect((await fx.storage.getInbound(receipt.requestId))?.status).toBe(
        'pending'
      )
      const client = await fx.client('secret-0', 0, modern)

      const claimed = await client.callTool({
        name: 'relanox_claim',
        arguments: { requestId: receipt.requestId, claimKey: 'remote-run-A' }
      })

      expect(claimed).toMatchObject({
        isError: false,
        structuredContent: { status: 'claimed', replay: false }
      })

      const token = z
        .object({ claimToken: z.string() })
        .parse(claimed.structuredContent).claimToken

      expect(
        await client.callTool({
          name: 'relanox_claim',
          arguments: { requestId: receipt.requestId, claimKey: 'remote-run-A' }
        })
      ).toMatchObject({
        structuredContent: { claimToken: token, replay: true }
      })
      expect(
        await client.callTool({
          name: 'relanox_claim',
          arguments: { requestId: receipt.requestId, claimKey: 'remote-run-B' }
        })
      ).toMatchObject({ isError: true, structuredContent: { status: 'busy' } })
      expect(
        await client.callTool({
          name: 'relanox_complete',
          arguments: {
            requestId: receipt.requestId,
            claimToken: 'wrong',
            resultId: 'result',
            text: 'answer'
          }
        })
      ).toMatchObject({
        isError: true,
        structuredContent: { status: 'unauthorized' }
      })
      expect(
        await client.callTool({
          name: 'relanox_complete',
          arguments: {
            requestId: receipt.requestId,
            claimToken: token,
            resultId: 'result',
            text: 'answer'
          }
        })
      ).toMatchObject({
        isError: false,
        structuredContent: { status: 'completed', replay: false }
      })
      expect(
        await client.callTool({
          name: 'relanox_complete',
          arguments: {
            requestId: receipt.requestId,
            claimToken: token,
            resultId: 'other-result',
            text: 'conflicting'
          }
        })
      ).toMatchObject({
        isError: true,
        structuredContent: { status: 'conflict' }
      })
      await fx.core.processDue()
      expect(fx.sent).toHaveLength(1)
      expect(fx.sent[0]).toMatchObject({
        target: { chatId: 'chat0', replyToId: 'original' },
        chunk: { text: 'answer' }
      })
      const next = await fx.ingest(0, 'later', 'event-2')

      const later = await client.callTool({
        name: 'relanox_claim',
        arguments: { requestId: next.requestId, claimKey: 'run-later' }
      })

      expect(later).toMatchObject({ structuredContent: { status: 'claimed' } })
      expect(
        await client.callTool({
          name: 'relanox_fail',
          arguments: {
            requestId: next.requestId,
            claimToken: z
              .object({ claimToken: z.string() })
              .parse(later.structuredContent).claimToken,
            errorCode: 'remote_failed'
          }
        })
      ).toMatchObject({
        isError: false,
        structuredContent: { status: 'updated' }
      })
      await fx.reopen(createGrokAgentPlugin())
      const reconnected = await fx.client('secret-0', 0, modern)
      expect(
        await reconnected.callTool({
          name: 'relanox_list_pending',
          arguments: {}
        })
      ).toMatchObject({ structuredContent: { requests: [] } })
      expect((await fx.storage.getInbound(next.requestId))?.status).toBe(
        'failed'
      )
    }
  )

  it('isolates endpoints and re-reads MCP/Routine SecretRefs for rotation', async () => {
    const { fx, receiver } = await setup()
    const other = await fx.ingest(1, 'private other', 'event-other')
    const client = await fx.client()
    expect(
      await client.callTool({
        name: 'relanox_claim',
        arguments: { requestId: other.requestId, claimKey: 'malicious' }
      })
    ).toMatchObject({
      isError: true,
      structuredContent: { status: 'not_found' }
    })
    const first = await fx.ingest()
    const snapshot = (await fx.storage.getInbound(first.requestId))?.snapshot
    if (!snapshot) {
      throw new Error('missing_request')
    }
    process.env.GROK_TEST_AUTH = 'Custom authorization-is-exact'
    expect(
      await fx.agent.dispatch({
        request: snapshot,
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'accepted' })
    expect(receiver.traffic[0]?.headers.authorization).toBe(
      'Custom authorization-is-exact'
    )
    process.env.AGENT_TEST_TOKEN_0 = 'rotated-token'
    await expect(
      client.callTool({
        name: 'relanox_list_pending',
        arguments: {}
      })
    ).rejects.toThrow()
    const rotated = await fx.client('rotated-token')
    expect(
      await rotated.callTool({
        name: 'relanox_list_pending',
        arguments: {}
      })
    ).toMatchObject({
      structuredContent: { requests: [{ requestId: first.requestId }] }
    })
  })

  it.each([
    [200, 'accepted', undefined],
    [202, 'accepted', undefined],
    [301, 'rejected', 'grok_http_301'],
    [401, 'rejected', 'grok_http_401'],
    [413, 'rejected', 'grok_http_413'],
    [408, 'unknown', 'grok_http_408'],
    [429, 'retryable', 'grok_http_429'],
    [503, 'retryable', 'grok_http_503']
  ] as const)(
    'maps HTTP %i receipt to %s',
    async (status, outcome, errorCode) => {
      let headers: Record<string, string> = {}
      if (status === 301) {
        headers = { Location: 'http://127.0.0.1:1/leak' }
      } else if (status === 429) {
        headers = { 'Retry-After': '3' }
      }
      const { fx } = await setup(status, headers)
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
        ...(errorCode ? { errorCode } : {}),
        ...(status === 429 ? { retryAfterMs: 3000 } : {})
      })
    }
  )

  it('preserves ambiguous network and aborted dispatches as unknown', async () => {
    const { fx, receiver } = await setup()
    const receipt = await fx.ingest()
    const request = (await fx.storage.getInbound(receipt.requestId))?.snapshot
    if (!request) {
      throw new Error('missing_request')
    }
    expect(
      await fx.agent.dispatch({ request, signal: AbortSignal.abort() })
    ).toEqual({
      status: 'unknown',
      errorCode: 'grok_trigger_uncertain'
    })
    expect(receiver.traffic).toHaveLength(0)
    await receiver.close()
    cleanups.shift()
    expect(
      await fx.agent.dispatch({
        request,
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'unknown', errorCode: 'grok_trigger_uncertain' })
  })

  it('rejects oversized payload and unapproved local transport before sending', async () => {
    const { fx, receiver } = await setup()
    const receipt = await fx.ingest()
    const request = (await fx.storage.getInbound(receipt.requestId))?.snapshot
    if (!request) {
      throw new Error('missing_request')
    }
    expect(
      await fx.agent.dispatch({
        request: {
          ...request,
          endpoint: {
            ...request.endpoint,
            config: {
              ...(request.endpoint.config as object),
              routineTransport: 'https'
            }
          }
        },
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'rejected', errorCode: 'grok_routine_url_invalid' })
    expect(
      await fx.agent.dispatch({
        request: { ...request, text: 'x'.repeat(1_048_576) },
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'rejected', errorCode: 'grok_body_too_large' })
    expect(receiver.traffic).toHaveLength(0)
  })
})
