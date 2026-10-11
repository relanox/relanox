import type { CoreRuntime } from '../../../packages/core/src/index.js'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Json,
  SendInput,
  Storage,
  InboundSnapshot,
  OutboundRecord
} from '@relanox/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createLineChannel } from '../src/index.js'
import { harness, peer } from './harness.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

const config = (base: string): Json => ({
  botUserId: 'bot',
  channelSecret: { env: 'LINE_SECRET' },
  accessToken: { env: 'LINE_TOKEN' },
  apiBase: base,
  allowLoopback: true
})

function webhook(text = 'hello', destination = 'bot', sender = 'user'): string {
  return JSON.stringify({
    destination,
    events: [
      {
        type: 'message',
        webhookEventId: 'event-1',
        timestamp: 1,
        source: { type: 'group', groupId: 'group', userId: sender },
        message: { id: 'message-1', type: 'text', text },
        replyToken: 'expired-token'
      }
    ]
  })
}

function incoming(body: string, signature?: string): Request {
  const expected = createHmac('sha256', 'secret').update(body).digest('base64')
  return new Request('http://local/channels/business/webhook', {
    method: 'POST',
    headers: { 'x-line-signature': signature ?? expected },
    body
  })
}

async function setup(filename?: string): Promise<{
  core: CoreRuntime
  storage: Storage
  dispatches: string[]
  complete(
    this: void,
    text?: string
  ): Promise<{
    request: InboundSnapshot
    delivery: OutboundRecord | undefined
  }>
  close(this: void): Promise<void>
  remote: Awaited<ReturnType<typeof peer>>
  plugin: ReturnType<typeof createLineChannel>
}> {
  vi.stubEnv('LINE_SECRET', 'secret')
  vi.stubEnv('LINE_TOKEN', 'token')
  const remote = await peer()
  cleanup.push(remote.close)
  remote.respond(200, { sentMessages: [{ id: 'sent-1' }] })
  const plugin = createLineChannel()

  const local = await harness(
    plugin,
    config(remote.base),
    'group',
    'user',
    undefined,
    filename
  )

  cleanup.push(local.close)
  return { remote, plugin, ...local }
}

describe('native LINE', () => {
  it.each(['identity', 'server', 'legacy'])(
    'refuses a persisted target after %s changes',
    async (change) => {
      const local = await setup()
      await local.core.fetch(incoming(webhook()))
      const completed = await local.complete()
      const outbound = completed.delivery
      if (!outbound?.chunks[0]) {
        throw new Error('Missing stored outbound')
      }
      const changedPlugin = createLineChannel()

      const changed = await harness(
        changedPlugin,
        {
          botUserId: change === 'identity' ? 'other-bot' : 'bot',
          channelSecret: { env: 'LINE_SECRET' },
          accessToken: { env: 'LINE_TOKEN' },
          apiBase:
            change === 'server'
              ? `${local.remote.base}/different`
              : local.remote.base,
          allowLoopback: true
        },
        'group',
        'user'
      )

      cleanup.push(changed.close)
      expect(
        await changedPlugin.send({
          deliveryId: outbound.deliveryId,
          requestId: outbound.requestId,
          target:
            change === 'legacy'
              ? {
                  ...outbound.target,
                  data: { destination: 'group', sourceType: 'group' }
                }
              : outbound.target,
          chunk: outbound.chunks[0],
          chunkIndex: 0,
          signal: new AbortController().signal
        })
      ).toEqual({ status: 'rejected', errorCode: 'invalid_target' })
      expect(local.remote.traffic).toHaveLength(1)
    }
  )

  it('keeps credential rotation on the same canonical API endpoint deliverable', async () => {
    const local = await setup()
    await local.core.fetch(incoming(webhook()))
    const completed = await local.complete()
    const outbound = completed.delivery
    if (!outbound?.chunks[0]) {
      throw new Error('Missing stored outbound')
    }
    vi.stubEnv('LINE_TOKEN', 'rotated-token')
    const restartedPlugin = createLineChannel()

    const restarted = await harness(
      restartedPlugin,
      config(`${local.remote.base}/`),
      'group',
      'user'
    )

    cleanup.push(restarted.close)
    expect(
      (
        await restartedPlugin.send({
          deliveryId: outbound.deliveryId,
          requestId: outbound.requestId,
          target: outbound.target,
          chunk: outbound.chunks[0],
          chunkIndex: 0,
          signal: new AbortController().signal
        })
      ).status
    ).toBe('sent')
    expect(local.remote.traffic[1]).toMatchObject({
      path: '/v2/bot/message/push',
      headers: { authorization: 'Bearer rotated-token' }
    })
  })

  it('authenticates exact bytes, deduplicates durably and independently pushes the frozen group', async () => {
    const local = await setup()
    expect((await local.core.fetch(incoming(webhook(), 'bad'))).status).toBe(
      401
    )
    expect((await local.core.fetch(incoming('{'))).status).toBe(400)
    expect(
      (await local.core.fetch(incoming(webhook('hello', 'other-bot')))).status
    ).toBe(403)
    expect((await local.core.fetch(incoming(`${webhook()}\n`))).status).toBe(
      200
    )
    expect((await local.core.fetch(incoming(webhook()))).status).toBe(200)
    expect((await local.storage.getStats()).pending).toBe(1)
    const completed = await local.complete()
    expect(local.dispatches).toEqual(['hello'])
    expect(completed.delivery?.status).toBe('sent')
    expect(completed.request.target).toEqual({
      channel: 'line',
      accountId: 'business',
      chatId: 'group',
      replyToId: 'message-1',
      data: {
        destination: 'group',
        sourceType: 'group',
        botId: 'bot',
        apiBaseUrl: local.remote.base
      }
    })
    const sent = local.remote.traffic[0]
    expect(sent?.path).toBe('/v2/bot/message/push')
    expect(sent?.headers.authorization).toBe('Bearer token')
    expect(JSON.parse(sent?.body ?? 'null') as unknown).toEqual({
      to: 'group',
      messages: [{ type: 'text', text: 'answer' }]
    })
    expect(sent?.headers['x-line-retry-key']).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('reuses a persisted push retry UUID across a SQLite close/reopen and accepts 409 receipts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relanox-line-'))
    cleanup.push(async () => {
      await rm(directory, { recursive: true })
    })
    const local = await setup(join(directory, 'state.db'))
    await local.core.fetch(incoming(webhook()))
    local.remote.respond(429, {}, { 'retry-after': '2' })
    const completed = await local.complete()
    const outbound = completed.delivery
    if (!outbound?.chunks[0]) {
      throw new Error('No outbound chunk')
    }

    const send: SendInput = {
      deliveryId: outbound.deliveryId,
      requestId: outbound.requestId,
      target: outbound.target,
      chunk: outbound.chunks[0],
      chunkIndex: 0,
      signal: new AbortController().signal
    }

    const retryKey = local.remote.traffic[0]?.headers['x-line-retry-key']
    await local.close()
    cleanup.pop()
    const restartedPlugin = createLineChannel()

    const restarted = await harness(
      restartedPlugin,
      config(local.remote.base),
      'group',
      'user',
      undefined,
      join(directory, 'state.db')
    )

    cleanup.push(restarted.close)
    local.remote.respond(
      409,
      {},
      { 'x-line-accepted-request-id': 'accepted-1' }
    )
    expect(await restartedPlugin.send(send)).toEqual({
      status: 'sent',
      receipt: { data: { acceptedRequestId: 'accepted-1' } }
    })
    expect(local.remote.traffic[1]?.headers['x-line-retry-key']).toBe(retryKey)
    const key = `push:${send.chunk.idempotencyKey}`
    const namespace = { pluginId: 'channel-line', ownerId: 'business' }
    const saved = await restarted.storage.getState(namespace, key)
    if (!saved) {
      throw new Error('Missing persisted retry identity')
    }
    const value = z.object({ retryKey: z.string() }).parse(saved.value)
    await restarted.storage.compareAndSetState(namespace, {
      key,
      expectedVersion: saved.version,
      value: { retryKey: value.retryKey, startedAt: Date.now() - 86_400_001 }
    })
    expect(await restartedPlugin.send(send)).toEqual({
      status: 'unknown',
      errorCode: 'retry_key_expired'
    })
    expect(local.remote.traffic).toHaveLength(2)
  })

  it.each([
    [429, 'retryable'],
    [403, 'rejected'],
    [503, 'unknown']
  ] as const)(
    'classifies HTTP %s without blind retries',
    async (status, expected) => {
      const local = await setup()
      await local.core.fetch(incoming(webhook()))
      local.remote.respond(status, {}, { 'retry-after': '2' })
      const completed = await local.complete()
      expect(completed.delivery?.status).toBe(
        expected === 'retryable' ? 'pending' : expected
      )
      if (expected === 'retryable') {
        expect(completed.delivery?.dueAt).toBeGreaterThan(Date.now() + 1000)
      }
      expect(local.remote.traffic).toHaveLength(1)
    }
  )

  it('ACKs only known policy exclusions and does not ACK real SQLite failures', async () => {
    const local = await setup()
    expect(
      (await local.core.fetch(incoming(webhook('hello', 'bot', 'denied-user'))))
        .status
    ).toBe(200)
    expect((await local.storage.getStats()).pending).toBe(0)
    await local.close()
    cleanup.pop()
    expect((await local.core.fetch(incoming(webhook()))).status).toBe(500)
  })

  it('rejects plain credentials and unauthorized HTTP endpoints', () => {
    const plugin = createLineChannel()
    expect(() =>
      plugin.validateConfig({
        botUserId: 'bot',
        channelSecret: 'secret',
        accessToken: 'token'
      })
    ).toThrow()
    expect(() =>
      plugin.validateConfig({
        botUserId: 'bot',
        channelSecret: { env: 'SECRET' },
        accessToken: { env: 'TOKEN' },
        apiBase: 'http://127.0.0.1:4000'
      })
    ).toThrow('unsafe_endpoint')
    expect(plugin.capabilities.idempotentSend).toBe(false)
  })
})
