import { z } from 'zod'
import { afterEach, expect, test, vi } from 'vitest'
import { sendMessage, dispatched, fixture, ingest } from './fixture.js'
import type { Cleanup } from './fixture.js'
import type { Traffic } from './peer.js'
import { validateApp } from '../../apps/cli/src/runtime.js'

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

// Protect default upload admission through CLI parsing, MCP status and real storage.
// Small-file tests cannot catch either default reverting to 25/50 MiB; no new seam is needed.
test.each([undefined, {}])(
  'admits 100 MiB uploads with mediaLimits=%j',
  async (mediaLimits) => {
    const fx = await fixture(cleanups)

    const runtime = await fx.start(
      await validateApp({ ...fx.config, mediaLimits })
    )

    const client = await fx.client(runtime, 'alpha')

    const status = await client.callTool({
      name: 'relanox_status',
      arguments: {}
    })

    const parsed = z
      .object({
        channels: z.array(z.object({ channel: z.object({ id: z.string() }) })),
        mediaLimits: z.object({
          maxBytes: z.number(),
          maxTotalBytes: z.number(),
          maxAttachments: z.number()
        })
      })
      .parse(status.structuredContent)

    expect(parsed.mediaLimits).toEqual({
      maxBytes: 104_857_600,
      maxTotalBytes: 104_857_600,
      maxAttachments: 10
    })
    const channel = parsed.channels[0]?.channel.id
    if (!channel) {
      throw new Error('Expected authorized channel')
    }

    const input = {
      channel,
      kind: 'file',
      mimeType: 'application/octet-stream',
      fileName: 'large.bin'
    }

    const accepted = await client.callTool({
      name: 'relanox_create_upload',
      arguments: { ...input, size: 104_857_600 }
    })

    expect(accepted.isError).not.toBe(true)
    expect(accepted.structuredContent).toMatchObject({
      uploadUrl: stringValue
    })

    const rejected = await client.callTool({
      name: 'relanox_create_upload',
      arguments: { ...input, size: 104_857_601 }
    })

    expect(rejected.isError).toBe(true)
  }
)

// Protect the network MCP/upload-to-channel contract: unit planner and native renderer tests
// Cannot catch a tool transport dropping Markdown references or appending their media twice.
test('uploads through MCP and sends an image at its Markdown position over the native channel', async () => {
  const fx = await fixture(cleanups)
  const runtime = await fx.start()
  const client = await fx.client(runtime, 'alpha')

  const status = await client.callTool({
    name: 'relanox_status',
    arguments: {}
  })

  const channels = z
    .object({
      channels: z.array(
        z.object({
          channel: z.object({ id: z.string() }),
          richText: z.string()
        })
      )
    })
    .parse(status.structuredContent).channels

  const channel = channels[0]?.channel.id
  if (!channel) {
    throw new Error('Expected authorized channel before first incoming message')
  }
  expect(channels[0]?.richText).toBe('sequential')
  const bytes = new Uint8Array([1, 2, 3])

  const upload = await client.callTool({
    name: 'relanox_create_upload',
    arguments: {
      channel,
      kind: 'image',
      mimeType: 'image/png',
      fileName: 'inline.png',
      size: bytes.length
    }
  })

  const ticket = z
    .object({
      uploadUrl: z.string(),
      headers: z.record(z.string(), z.string())
    })
    .parse(upload.structuredContent)

  const uploaded = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers: ticket.headers,
    body: bytes
  })

  expect(uploaded.status).toBe(200)

  const { fileId } = z
    .object({ fileId: z.string() })
    .parse(await uploaded.json())

  const text = `Before![inline](relanox://media/${fileId})After`
  const receipt = await sendMessage(client, channel, text, 'rich-network')
  expect(receipt.replay).toBe(false)
  await expect
    .poll(async () => (await runtime.core.status()).deliveries[0]?.status, {
      timeout: 5000
    })
    .toBe('sent')
  expect(fx.telegram.traffic.map((item) => item.url)).toEqual([
    '/bot123:telegram-secret/sendMessage',
    '/bot123:telegram-secret/sendPhoto',
    '/bot123:telegram-secret/sendMessage'
  ])
  expect(JSON.parse(fx.telegram.traffic[0]?.body ?? '')).toMatchObject({
    text: 'Before',
    chat_id: '101',
    message_thread_id: 9
  })
  expect(fx.telegram.traffic[1]?.body).toContain('filename="inline.png"')
  expect(fx.telegram.traffic[1]?.headers['content-type']).toMatch(
    /^multipart\/form-data;/u
  )
  expect(JSON.parse(fx.telegram.traffic[2]?.body ?? '')).toMatchObject({
    text: 'After',
    chat_id: '101',
    message_thread_id: 9
  })
  expect(await sendMessage(client, channel, text, 'rich-network')).toEqual({
    ...receipt,
    replay: true
  })
  expect(fx.telegram.traffic).toHaveLength(3)
  expect(fx.routine.traffic).toHaveLength(0)
})

test('native HTTP, official network MCP and resident worker relay a scoped final to its original Telegram target', async () => {
  const fx = await fixture(cleanups)
  const runtime = await fx.start()
  expect((await ingest(runtime)).status).toBe(204)
  expect((await ingest(runtime)).status).toBe(204)
  await expect.poll(() => fx.routine.traffic.length, { timeout: 5000 }).toBe(1)
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
    requestId: stringValue,
    text: '中文\nhello 🌍',
    context: null,
    source: {
      channel: {
        id: stringValue,
        platform: 'telegram',
        accountId: 'bot',
        chatId: '101',
        threadId: '9'
      },
      senderId: '17'
    }
  })
  await expect
    .poll(async () => (await runtime.core.status()).stats.pending, {
      timeout: 5000
    })
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
        channel: request.source.channel.id,
        text: 'untrusted cross-scope answer'
      }
    })
  ).toMatchObject({ structuredContent: { status: 'not_found' }, isError: true })
  const alpha = await fx.client(runtime, 'alpha')
  expect((await alpha.listTools()).tools.map((tool) => tool.name)).toEqual([
    'relanox_status',
    'relanox_send_message',
    'relanox_create_upload',
    'relanox_read_media'
  ])

  const result = await sendMessage(
    alpha,
    request.source.channel.id,
    '最终 answer 🌍',
    `result-${request.source.channel.id}`,
    request.requestId
  )

  expect(result.replay).toBe(false)
  expect(
    await sendMessage(
      alpha,
      request.source.channel.id,
      '最终 answer 🌍',
      `result-${request.source.channel.id}`,
      request.requestId
    )
  ).toEqual({ ...result, replay: true })
  await expect
    .poll(async () => (await runtime.core.status()).deliveries[0]?.status, {
      timeout: 5000
    })
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

  const replyStatus = z
    .object({
      request: z.object({
        id: z.string(),
        reply: z.object({ status: z.string(), deliveryId: z.string() })
      })
    })
    .parse(
      (
        await alpha.callTool({
          name: 'relanox_status',
          arguments: { requestId: request.requestId }
        })
      ).structuredContent
    )

  expect(replyStatus.request).toEqual({
    id: request.requestId,
    reply: { status: 'sent', deliveryId: result.deliveryId }
  })
  const status = await runtime.core.status()
  expect(status.stats).toMatchObject({
    pending: 0,
    undelivered: 0,
    unknown: 0
  })
  expect(status.requests).toMatchObject([
    {
      dispatch: { status: 'accepted' },
      reply: { finalDeliveryId: result.deliveryId }
    }
  ])
  expect(status.deliveries).toMatchObject([
    {
      status: 'sent',
      currentChunk: 1,
      receipts: [{ platformMessageId: '700' }]
    }
  ])

  const second = await sendMessage(
    alpha,
    request.source.channel.id,
    'second response',
    'second-response'
  )

  expect(second.deliveryId).not.toBe(result.deliveryId)
  await expect.poll(() => fx.telegram.traffic.length, { timeout: 5000 }).toBe(2)
  expect(JSON.parse(fx.telegram.traffic[1]?.body ?? '')).toMatchObject({
    text: 'second response',
    chat_id: '101'
  })
  expect(fx.routine.traffic).toHaveLength(1)
})

test('runtime restart preserves queued destinations while new sends and events use current binding ownership', async () => {
  const fx = await fixture(cleanups, (_traffic, index) =>
    index === 0
      ? {
          status: 429,
          body: {
            ok: false,
            error_code: 429,
            description: 'retry later',
            parameters: { retry_after: 2 }
          }
        }
      : { body: { ok: true, result: { message_id: 700 } } }
  )

  const before = await fx.start()
  expect((await ingest(before)).status).toBe(204)
  await expect.poll(() => fx.routine.traffic.length, { timeout: 5000 }).toBe(1)
  const request = dispatched(firstTraffic(fx.routine.traffic))
  const alphaBefore = await fx.client(before, 'alpha')

  const queued = await sendMessage(
    alphaBefore,
    request.source.channel.id,
    '最终 answer 🌍',
    `result-${request.source.channel.id}`,
    request.requestId
  )

  await expect
    .poll(async () => (await before.core.status()).deliveries[0]?.attempts, {
      timeout: 5000
    })
    .toBe(1)
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
      reply: { finalDeliveryId: queued.deliveryId },
      snapshot: {
        endpoint: { id: 'alpha' },
        channel: { id: request.source.channel.id, chatId: '101', threadId: '9' }
      }
    }
  ])
  await expect
    .poll(
      async () =>
        (await after.core.status()).deliveries.find(
          (delivery) => delivery.deliveryId === queued.deliveryId
        )?.status,
      { timeout: 5000 }
    )
    .toBe('sent')
  expect((await after.core.status()).deliveries[0]).toMatchObject({
    channelId: request.source.channel.id,
    endpoint: { id: 'alpha' },
    target: { chatId: '101', threadId: '9' }
  })
  expect(JSON.parse(fx.telegram.traffic[1]?.body ?? '')).toMatchObject({
    reply_parameters: { message_id: 41, allow_sending_without_reply: true }
  })
  const alphaAfter = await fx.client(after, 'alpha')
  const beta = await fx.client(after, 'beta')
  for (const client of [alphaAfter, beta]) {
    expect(
      await client.callTool({
        name: 'relanox_send_message',
        arguments: { channel: request.source.channel.id, text: 'old ownership' }
      })
    ).toMatchObject({
      isError: true,
      structuredContent: { status: 'not_found' }
    })
  }

  const authorized = z
    .object({
      channels: z.array(
        z.object({ channel: z.object({ id: z.string(), chatId: z.string() }) })
      )
    })
    .parse(
      (await beta.callTool({ name: 'relanox_status', arguments: {} }))
        .structuredContent
    )

  const channel = authorized.channels.find(
    (entry) => entry.channel.chatId === '101'
  )?.channel.id

  if (!channel) {
    throw new Error('Missing new bound channel')
  }
  expect(channel).not.toBe(request.source.channel.id)
  expect((await sendMessage(beta, channel, 'new binding answer')).replay).toBe(
    false
  )
  await expect.poll(() => fx.telegram.traffic.length, { timeout: 5000 }).toBe(3)
  expect(JSON.parse(fx.telegram.traffic[2]?.body ?? '')).toMatchObject({
    text: 'new binding answer',
    chat_id: '101',
    message_thread_id: 9
  })
  expect((await ingest(after, 2, 101, 'new binding message')).status).toBe(204)
  await expect.poll(() => fx.routine.traffic.length, { timeout: 5000 }).toBe(2)
  const newWire = fx.routine.traffic[1]
  if (!newWire) {
    throw new Error('Expected new binding Routine dispatch')
  }
  expect(newWire.url).toBe('/beta')
  expect(dispatched(newWire)).toMatchObject({
    text: 'new binding message',
    source: { channel: { id: channel }, senderId: '17' }
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
  await expect.poll(() => fx.routine.traffic.length, { timeout: 5000 }).toBe(1)
  const request = dispatched(firstTraffic(fx.routine.traffic))
  const alpha = await fx.client(before, 'alpha')

  const final = await sendMessage(
    alpha,
    request.source.channel.id,
    'saved final',
    `result-${request.source.channel.id}`,
    request.requestId
  )

  await expect
    .poll(async () => (await before.core.status()).deliveries[0]?.status, {
      timeout: 5000
    })
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
    target: { chatId: '101', threadId: '9' }
  })
  expect(status.requests).toMatchObject([
    {
      dispatch: { status: 'accepted' },
      reply: { finalDeliveryId: final.deliveryId }
    }
  ])
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
    .poll(async () => (await after.core.status()).deliveries[0]?.status, {
      timeout: 5000
    })
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
