import { afterEach, expect, test, vi } from 'vitest'
import { sendMessage, dispatched, fixture, ingest } from './fixture.js'
import type { Cleanup } from './fixture.js'
import type { Traffic } from './peer.js'

const cleanups: Cleanup[] = []
const stringValue: unknown = expect.any(String)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  vi.unstubAllEnvs()
})

function firstTraffic(traffic: readonly Traffic[]): Traffic {
  const first = traffic[0]
  if (!first) {
    throw new Error('Expected recorded external HTTP traffic')
  }
  return first
}

test('native HTTP, official network MCP and resident worker relay a scoped final to its original Telegram target', async () => {
  const fx = await fixture(cleanups)
  const runtime = await fx.start()
  expect((await ingest(runtime)).status).toBe(204)
  expect((await ingest(runtime)).status).toBe(204)
  await expect.poll(() => fx.routine.traffic.length).toBe(1)
  const wire = firstTraffic(fx.routine.traffic)
  const request = dispatched(wire)
  expect(wire).toMatchObject({
    method: 'POST',
    url: '/alpha',
    headers: {
      authorization: 'Bearer routine-secret',
      'content-type': 'application/json'
    }
  })
  expect(request).toEqual({
    replyTo: stringValue,
    text: '中文\nhello 🌍',
    context: { messageId: '41' },
    source: { channel: 'telegram', eventId: '1' }
  })
  await expect
    .poll(async () => (await runtime.core.status()).stats.pending)
    .toBe(0)

  const wrongCredential = await fetch(
    `${runtime.businessUrl}/agents/grok/mcp/alpha`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer beta-secret',
        'Content-Type': 'application/json'
      },
      body: '{}'
    }
  )

  expect(wrongCredential.status).toBe(401)
  const beta = await fx.client(runtime, 'beta')
  expect(
    await beta.callTool({
      name: 'relanox_send_message',
      arguments: {
        replyTo: request.replyTo,
        text: 'untrusted cross-scope answer'
      }
    })
  ).toMatchObject({ structuredContent: { status: 'not_found' }, isError: true })
  const alpha = await fx.client(runtime, 'alpha')
  expect((await alpha.listTools()).tools.map((tool) => tool.name)).toEqual([
    'relanox_send_message',
    'relanox_read_media'
  ])
  const result = await sendMessage(alpha, request.replyTo)
  expect(result.replay).toBe(false)
  expect(await sendMessage(alpha, request.replyTo)).toEqual({
    ...result,
    replay: true
  })
  await expect
    .poll(async () => (await runtime.core.status()).deliveries[0]?.status)
    .toBe('sent')
  expect(fx.telegram.traffic).toHaveLength(1)
  const sent = firstTraffic(fx.telegram.traffic)
  expect(sent).toMatchObject({
    method: 'POST',
    url: '/bot123:telegram-secret/sendMessage'
  })
  expect(JSON.parse(sent.body)).toEqual({
    chat_id: '101',
    message_thread_id: 9,
    text: '最终 answer 🌍',
    reply_parameters: { message_id: 41, allow_sending_without_reply: true },
    link_preview_options: { is_disabled: true }
  })
  const status = await runtime.core.status()
  expect(status.stats).toMatchObject({
    pending: 0,
    undelivered: 0,
    unknown: 0
  })
  expect(status.requests).toMatchObject([{ dispatch: { status: 'accepted' } }])
  expect(status.deliveries).toMatchObject([
    {
      status: 'sent',
      currentChunk: 1,
      receipts: [{ platformMessageId: '700' }]
    }
  ])

  const second = await sendMessage(
    alpha,
    request.replyTo,
    'second response',
    'second-response'
  )

  expect(second.deliveryId).not.toBe(result.deliveryId)
  await expect.poll(() => fx.telegram.traffic.length).toBe(2)
  expect(JSON.parse(fx.telegram.traffic[1]?.body ?? '')).toMatchObject({
    text: 'second response',
    chat_id: '101',
    reply_parameters: { message_id: 41 }
  })
  expect(fx.routine.traffic).toHaveLength(1)
})

test('runtime restart preserves incoming messages and frozen routing while new events follow a changed binding', async () => {
  const fx = await fixture(cleanups)
  const before = await fx.start()
  expect((await ingest(before)).status).toBe(204)
  await expect.poll(() => fx.routine.traffic.length).toBe(1)
  const request = dispatched(firstTraffic(fx.routine.traffic))
  const alphaBefore = await fx.client(before, 'alpha')
  await alphaBefore.close()
  await before.stop()

  const changed = {
    ...fx.config,
    relay: {
      ...fx.config.relay,
      bindings: fx.config.relay.bindings.map((binding) => ({
        ...binding,
        endpointId: 'beta'
      }))
    }
  }

  const after = await fx.start(changed)
  const persisted = await after.core.status()
  expect(persisted.requests).toMatchObject([
    {
      dispatch: { status: 'accepted' },
      snapshot: {
        endpoint: { id: 'alpha' },
        target: { chatId: '101', threadId: '9', replyToId: '41' }
      }
    }
  ])
  await after.core.processDue()
  expect(fx.routine.traffic).toHaveLength(1)
  expect(fx.telegram.traffic).toHaveLength(0)
  const alphaAfter = await fx.client(after, 'alpha')
  const beta = await fx.client(after, 'beta')
  expect(
    await beta.callTool({
      name: 'relanox_send_message',
      arguments: { replyTo: request.replyTo, text: 'replacement answer' }
    })
  ).toMatchObject({ isError: true, structuredContent: { status: 'not_found' } })
  expect((await sendMessage(alphaAfter, request.replyTo)).replay).toBe(false)
  await expect
    .poll(async () => (await after.core.status()).deliveries[0]?.status)
    .toBe('sent')
  expect(JSON.parse(firstTraffic(fx.telegram.traffic).body)).toMatchObject({
    chat_id: '101',
    message_thread_id: 9,
    reply_parameters: { message_id: 41 },
    text: '最终 answer 🌍'
  })
  expect((await ingest(after, 2, 101, 'new binding message')).status).toBe(204)
  await expect.poll(() => fx.routine.traffic.length).toBe(2)
  const newWire = fx.routine.traffic[1]
  if (!newWire) {
    throw new Error('Expected new binding Routine dispatch')
  }
  expect(newWire.url).toBe('/beta')
  const later = dispatched(newWire)
  expect(later).toMatchObject({
    text: 'new binding message',
    source: { eventId: '2' }
  })
  expect(
    (await sendMessage(beta, later.replyTo, 'new binding answer')).replay
  ).toBe(false)
  await expect.poll(() => fx.telegram.traffic.length).toBe(2)
  expect(JSON.parse(fx.telegram.traffic[1]?.body ?? '')).toMatchObject({
    text: 'new binding answer',
    chat_id: '101',
    reply_parameters: { message_id: 42 }
  })
})

test('an uncertain native send stays held across restart and explicit delivery recovery never reruns its agent', async () => {
  const fx = await fixture(cleanups, (_traffic, index) =>
    index === 0
      ? { dropConnection: true }
      : { body: { ok: true, result: { message_id: 701 } } }
  )

  const before = await fx.start()
  expect((await ingest(before)).status).toBe(204)
  await expect.poll(() => fx.routine.traffic.length).toBe(1)
  const request = dispatched(firstTraffic(fx.routine.traffic))
  const alpha = await fx.client(before, 'alpha')
  const final = await sendMessage(alpha, request.replyTo, 'saved final')

  await expect
    .poll(async () => (await before.core.status()).deliveries[0]?.status)
    .toBe('unknown')
  expect(fx.telegram.traffic).toHaveLength(1)
  await alpha.close()
  await before.stop()
  const after = await fx.start()
  const status = await after.core.status()
  const held = status.deliveries[0]
  if (!held) {
    throw new Error('Expected persisted unknown delivery')
  }
  expect(held).toMatchObject({
    deliveryId: final.deliveryId,
    status: 'unknown',
    currentChunk: 0,
    chunks: [{ text: 'saved final' }],
    target: { chatId: '101', threadId: '9', replyToId: '41' }
  })
  expect(status.requests).toMatchObject([{ dispatch: { status: 'accepted' } }])
  await after.core.processDue()
  await after.core.processDue()
  expect(fx.telegram.traffic).toHaveLength(1)
  expect(fx.routine.traffic).toHaveLength(1)

  const recovery = {
    kind: 'delivery' as const,
    id: held.deliveryId,
    expectedVersion: held.version
  }

  expect(
    await after.core.requeue({ ...recovery, acknowledgeUnknown: false })
  ).toEqual({
    status: 'conflict'
  })
  expect(
    await after.core.requeue({ ...recovery, acknowledgeUnknown: true })
  ).toEqual({
    status: 'updated',
    version: held.version + 1
  })
  await expect
    .poll(async () => (await after.core.status()).deliveries[0]?.status)
    .toBe('sent')
  expect(fx.telegram.traffic).toHaveLength(2)
  expect(
    fx.telegram.traffic.map((record) => JSON.parse(record.body) as unknown)
  ).toEqual([
    {
      chat_id: '101',
      message_thread_id: 9,
      text: 'saved final',
      reply_parameters: { message_id: 41, allow_sending_without_reply: true },
      link_preview_options: { is_disabled: true }
    },
    {
      chat_id: '101',
      message_thread_id: 9,
      text: 'saved final',
      reply_parameters: { message_id: 41, allow_sending_without_reply: true },
      link_preview_options: { is_disabled: true }
    }
  ])
  const recovered = await after.core.status()
  expect(recovered.requests).toHaveLength(1)
  expect(recovered.deliveries).toHaveLength(1)
  expect(recovered.stats).toMatchObject({
    pending: 0,
    undelivered: 0,
    unknown: 0
  })
  expect(recovered.deliveries[0]).toMatchObject({
    currentChunk: 1,
    receipts: [{ platformMessageId: '701' }]
  })
  expect(fx.routine.traffic).toHaveLength(1)
})
