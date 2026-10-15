import type { SendInput } from '@relanox/sdk'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createMatrixChannel } from '../src/index.js'
import {
  body,
  harness,
  httpPeer,
  json,
  observations,
  waitFor
} from './harness.js'

const user = '@alice:local.test'
const room = '!room:local.test'
const thread = '$thread-root'

function config(base: string): {
  homeserver: string

  accessToken: { env: string }
  allowInsecureLocalhost: boolean
} {
  return {
    homeserver: base,
    accessToken: { env: 'MATRIX_TOKEN' },
    allowInsecureLocalhost: true
  }
}

function event(
  eventId: string,
  text: string,
  sender = user
): {
  event_id: string
  sender: string
  type: string
  origin_server_ts: number
  content: {
    msgtype: string
    body: string
    'm.relates_to': {
      rel_type: string
      event_id: string
      'm.in_reply_to': { event_id: string }
    }
  }
} {
  return {
    event_id: eventId,
    sender,
    type: 'm.room.message',
    origin_server_ts: 1_800_000_000_000,
    content: {
      msgtype: 'm.text',
      body: text,
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: thread,
        'm.in_reply_to': { event_id: '$parent' }
      }
    }
  }
}

function input(
  target: SendInput['target'],
  text = 'delayed answer'
): SendInput {
  return {
    deliveryId: 'delivery',
    channelId: 'request',
    target,
    chunk: { text, idempotencyKey: 'durable-delivery:0', state: null },
    chunkIndex: 0,
    signal: new AbortController().signal
  }
}

it('persists threaded sync before cursor, filters identities and sends the frozen delayed target', async () => {
  const syncs: { since: string | null; authorization: string | undefined }[] =
    []

  const sent: {
    path: string
    method: string | undefined
    authorization: string | undefined
    data: unknown
  }[] = []

  const dispatches: unknown[] = []
  const observation = observations()
  let encrypted = false

  const peer = await httpPeer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://peer')
    if (url.pathname.endsWith('/sync')) {
      syncs.push({
        since: url.searchParams.get('since'),
        authorization: request.headers.authorization
      })

      const events =
        syncs.length === 1
          ? [
              event('$incoming', 'question'),
              event('$incoming', 'question'),
              event('$own', 'echo', '@bot:local.test'),
              event('$blocked', 'blocked', '@mallory:local.test'),
              {
                ...event('$encrypted', 'cipher'),
                type: 'm.room.encrypted',
                content: {
                  algorithm: 'm.megolm.v1.aes-sha2',
                  ciphertext: 'unreadable'
                }
              }
            ]
          : []

      json(response, {
        next_batch: 'batch-committed',
        rooms: { join: { [room]: { timeline: { events } } } }
      })
      return
    }
    if (url.pathname.endsWith('/state/m.room.encryption')) {
      json(
        response,
        encrypted
          ? { algorithm: 'm.megolm.v1.aes-sha2' }
          : { errcode: 'M_NOT_FOUND' },
        encrypted ? 200 : 404
      )
      return
    }
    if (url.pathname.includes('/send/')) {
      sent.push({
        path: url.pathname,
        method: request.method,
        authorization: request.headers.authorization,
        data: await body(request)
      })
      json(response, { event_id: '$sent' })
      return
    }
    dispatches.push(await body(request))
    json(response, {})
  })

  const plugin = createMatrixChannel({ MATRIX_TOKEN: 'matrix-access-secret' })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`,
    { observe: observation.observe }
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (
        await fixture.storage.getState(
          { pluginId: 'channel-matrix', ownerId: 'bot' },
          'sync'
        )
      )?.value === 'batch-committed'
  )
  await plugin.stop?.()
  const requests = await fixture.storage.listInbound({ limit: 20 })
  expect(requests).toHaveLength(1)
  const request = requests[0]
  if (!request) {
    throw new Error('Missing request')
  }
  expect(request.snapshot.target).toEqual({
    channel: 'matrix',
    accountId: 'bot',
    chatId: room,
    threadId: thread,
    replyToId: '$incoming',
    data: { homeserver: peer.base, userId: '@bot:local.test' }
  })
  expect(request.snapshot.senderId).toBe(user)
  expect(syncs[0]).toEqual({
    since: null,
    authorization: 'Bearer matrix-access-secret'
  })
  expect(
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'encrypted_unsupported'
    )
  ).toBe(true)
  expect(
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'sender_not_allowed'
    )
  ).toBe(true)
  expect(JSON.stringify(request.snapshot)).not.toContain('matrix-access-secret')
  await fixture.runtime.processDue()
  expect(dispatches).toEqual([
    { channel: request.snapshot.channel.id, text: 'question' }
  ])

  const completed = await fixture.sendReply(
    request.snapshot.requestId,
    '**answer** [link](https://example.com) <script>alert(1)</script>'
  )

  await fixture.runtime.processDue()
  expect(
    (await fixture.storage.getOutbound(completed.deliveryId))?.status
  ).toBe('sent')
  expect(sent[0]?.method).toBe('PUT')
  expect(sent[0]?.authorization).toBe('Bearer matrix-access-secret')
  expect(sent[0]?.path).toContain(
    '/rooms/!room%3Alocal.test/send/m.room.message/'
  )
  expect(sent[0]?.data).toEqual({
    msgtype: 'm.text',
    body: '**answer** [link](https://example.com) <script>alert(1)</script>',
    format: 'org.matrix.custom.html',
    formatted_body:
      '<p><strong>answer</strong> <a href="https://example.com/">link</a> &lt;script&gt;alert(1)&lt;/script&gt;</p>\n',
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: thread
    }
  })
  await plugin.send(input(request.snapshot.target))
  await plugin.send(input(request.snapshot.target))
  expect(sent.at(-1)?.path).toBe(sent.at(-2)?.path)
  encrypted = true
  expect(await plugin.send(input(request.snapshot.target))).toEqual({
    status: 'rejected',
    errorCode: 'encrypted_unsupported'
  })
  expect(sent).toHaveLength(3)
  expect(plugin.capabilities.idempotentSend).toBe(false)
})

it('bounds the combined Markdown and HTML text sent to Matrix after escaping expands it', async () => {
  const sent: { body: string; formatted_body: string; format: string }[] = []

  const peer = await httpPeer(async (request, response) => {
    if (request.url?.includes('/state/')) {
      json(response, { errcode: 'M_NOT_FOUND' }, 404)
      return
    }
    sent.push(
      z
        .object({
          body: z.string(),
          formatted_body: z.string(),
          format: z.string()
        })
        .parse(await body(request))
    )
    json(response, { event_id: '$sent' })
  })

  const plugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })
  await harness(
    plugin,
    config(peer.base),
    [{ chatId: room }],
    [user],
    `${peer.base}/dispatch`
  )

  const target: SendInput['target'] = {
    channel: 'matrix',
    accountId: 'bot',
    chatId: room,
    data: { homeserver: peer.base, userId: '@bot:local.test' }
  }

  const markdown = '&'.repeat(6000)
  const chunks = plugin.splitText?.(markdown, target)
  if (!chunks) {
    throw new Error('Missing Matrix Markdown splitting')
  }
  for (const [index, text] of chunks.entries()) {
    const outgoing = input(target)
    expect(
      await plugin.send({
        ...outgoing,
        chunk: { ...outgoing.chunk, text, idempotencyKey: `escaped:${index}` }
      })
    ).toEqual({ status: 'sent', receipt: { platformMessageId: '$sent' } })
  }
  expect(sent.length).toBeGreaterThan(1)
  expect(sent.map((message) => message.body).join('')).toBe(markdown)
  for (const message of sent) {
    expect(message.format).toBe('org.matrix.custom.html')
    expect(message.formatted_body).toContain('&amp;')
    expect(
      Buffer.byteLength(message.body) +
        Buffer.byteLength(message.formatted_body)
    ).toBeLessThanOrEqual(16_000)
  }
})

it('replays from the last committed cursor after a real storage failure and restart', async () => {
  const calls: (string | null)[] = []
  let release: (() => void) | undefined
  let failNext = false
  const observation = observations()

  const peer = await httpPeer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://peer')
    if (!url.pathname.endsWith('/sync')) {
      json(response, {})
      return
    }
    const since = url.searchParams.get('since')
    calls.push(since)
    if (failNext) {
      failNext = false
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    json(response, {
      next_batch: since ? 'batch-after' : 'batch-before',
      rooms: {
        join: {
          [room]: {
            timeline: {
              events: since ? [event('$after-restart', 'recovered')] : []
            }
          }
        }
      }
    })
  })

  const firstPlugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })

  const first = await harness(
    firstPlugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`,
    { observe: observation.observe }
  )

  await firstPlugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (
        await first.storage.getState(
          { pluginId: 'channel-matrix', ownerId: 'bot' },
          'sync'
        )
      )?.value === 'batch-before'
  )
  await firstPlugin.stop?.()
  failNext = true
  await firstPlugin.start?.(new AbortController().signal)
  await waitFor(() => release !== undefined)
  await first.storage.close()
  release?.()
  await waitFor(() =>
    observation.logs.some((entry) => entry.fields?.errorCode === 'sync_failed')
  )
  await firstPlugin.stop?.()
  const nextPlugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })

  const next = await harness(
    nextPlugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`,
    { filename: first.filename }
  )

  await nextPlugin.start?.(new AbortController().signal)
  await waitFor(
    async () => (await next.storage.listInbound({ limit: 10 })).length === 1
  )
  await nextPlugin.stop?.()
  expect(calls.at(-1)).toBe('batch-before')
  expect(
    (await next.storage.listInbound({ limit: 10 }))[0]?.snapshot.text
  ).toBe('recovered')
  expect(
    (
      await next.storage.getState(
        { pluginId: 'channel-matrix', ownerId: 'bot' },
        'sync'
      )
    )?.value
  ).toBe('batch-after')
})

it('refuses to advance a limited timeline from an existing checkpoint', async () => {
  const peer = await httpPeer((_request, response) => {
    json(response, {
      next_batch: 'skipped',
      rooms: {
        join: {
          [room]: {
            timeline: { limited: true, events: [event('$limited', 'recent')] }
          }
        }
      }
    })
  })

  const plugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })
  const observation = observations()

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`,
    { observe: observation.observe }
  )

  await fixture.storage.compareAndSetState(
    { pluginId: 'channel-matrix', ownerId: 'bot' },
    { key: 'sync', expectedVersion: null, value: 'older' }
  )
  await plugin.start?.(new AbortController().signal)
  await waitFor(() =>
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'sync_history_gap'
    )
  )
  await plugin.stop?.()
  expect(
    (
      await fixture.storage.getState(
        { pluginId: 'channel-matrix', ownerId: 'bot' },
        'sync'
      )
    )?.value
  ).toBe('older')
  expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([])
})

// /sync includes every joined room, even rooms without a local binding.
// Matrix JS SDK d633e7c1954a6b92597fbc3f8a95f183789a8d40 src/sync.ts:processSyncResponse.
// https://spec.matrix.org/v1.15/client-server-api/#get_matrixclientv3sync
it('ignores history gaps in unbound joined rooms while persisting a configured room', async () => {
  const syncs: (string | null)[] = []

  const peer = await httpPeer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://peer')
    syncs.push(url.searchParams.get('since'))
    json(response, {
      next_batch: 'after-bound-room',
      rooms: {
        join: {
          '!unbound:example.org': {
            timeline: { limited: true, events: [event('$unbound', 'unbound')] }
          },
          [room]: {
            timeline: { events: [event('$bound', 'bound message')] }
          }
        }
      }
    })
  })

  const plugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`
  )

  await fixture.storage.compareAndSetState(
    { pluginId: 'channel-matrix', ownerId: 'bot' },
    { key: 'sync', expectedVersion: null, value: 'older' }
  )
  await plugin.start?.(new AbortController().signal)
  await waitFor(() => syncs.length >= 2)
  await plugin.stop?.()
  expect(syncs.slice(0, 2)).toEqual(['older', 'after-bound-room'])
  const records = await fixture.storage.listInbound({ limit: 10 })
  expect(records).toHaveLength(1)
  expect(records[0]?.snapshot).toMatchObject({
    source: { eventId: '$bound' },
    text: 'bound message',
    target: { chatId: room, threadId: thread }
  })
})

it.each([
  [429, 'retryable'],
  [403, 'rejected'],
  [503, 'unknown']
] as const)(
  'maps HTTP %i without guessing send effects',
  async (status, outcome) => {
    const peer = await httpPeer((request, response) => {
      if (request.url?.includes('/state/')) {
        json(response, { errcode: 'M_NOT_FOUND' }, 404)
      } else {
        response.setHeader('Retry-After', '7')
        json(response, {}, status)
      }
    })

    const plugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })
    await harness(
      plugin,
      config(peer.base),
      [{ chatId: room }],
      [user],
      `${peer.base}/dispatch`
    )

    const result = await plugin.send(
      input({
        channel: 'matrix',
        accountId: 'bot',
        chatId: room,
        data: { homeserver: peer.base, userId: '@bot:local.test' }
      })
    )

    expect(result.status).toBe(outcome)
    if (result.status === 'retryable') {
      expect(result.retryAfterMs).toBe(7000)
    }
  }
)

it.each(['unavailable', 'connection-loss'] as const)(
  'retries encryption preflight %s before any message is sent',
  async (mode) => {
    let healthy = false
    let sends = 0

    const peer = await httpPeer((request, response) => {
      if (request.url?.includes('/state/')) {
        if (healthy) {
          json(response, { errcode: 'M_NOT_FOUND' }, 404)
        } else if (mode === 'connection-loss') {
          request.socket.destroy()
        } else {
          json(response, { errcode: 'M_UNKNOWN' }, 503)
        }
        return
      }
      sends += 1
      json(response, { event_id: '$sent' })
    })

    const plugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })
    await harness(
      plugin,
      config(peer.base),
      [{ chatId: room }],
      [user],
      `${peer.base}/dispatch`
    )

    const outgoing = input({
      channel: 'matrix',
      accountId: 'bot',
      chatId: room,
      data: { homeserver: peer.base, userId: '@bot:local.test' }
    })

    expect((await plugin.send(outgoing)).status).toBe('retryable')
    expect(sends).toBe(0)
    healthy = true
    expect(await plugin.send(outgoing)).toEqual({
      status: 'sent',
      receipt: { platformMessageId: '$sent' }
    })
    expect(sends).toBe(1)
  }
)

it('rejects inline secrets and untrusted plaintext or credential-bearing homeservers', () => {
  const plugin = createMatrixChannel()
  expect(() =>
    plugin.validateConfig({
      ...config('https://matrix.example'),
      accessToken: 'plaintext'
    })
  ).toThrow()
  expect(() => plugin.validateConfig(config('http://remote.example'))).toThrow()
  expect(() =>
    plugin.validateConfig(config('https://user:password@matrix.example'))
  ).toThrow()
  expect(() =>
    plugin.validateConfig({
      ...config('http://127.0.0.1:9000'),
      allowInsecureLocalhost: false
    })
  ).toThrow()
})

it('returns from start and aborts an outstanding sync connection on stop', async () => {
  let opened = false
  let closed = false

  const peer = await httpPeer((_request, response) => {
    opened = true
    response.once('close', () => {
      closed = true
    })
  })

  const plugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })
  await harness(
    plugin,
    config(peer.base),
    [{ chatId: room }],
    [user],
    `${peer.base}/dispatch`
  )
  await plugin.start?.(new AbortController().signal)
  await waitFor(() => opened)
  await plugin.stop?.()
  await waitFor(() => closed)
  expect(closed).toBe(true)
})

// Matrix JS SDK d633e7c1954a6b92597fbc3f8a95f183789a8d40,
// Src/client.ts:addThreadRelationIfNeeded: explicit replies are not thread fallbacks.
// https://spec.matrix.org/v1.15/client-server-api/#threading
it('preserves an explicit threaded reply on the native HTTP send boundary', async () => {
  const sent: unknown[] = []

  const peer = await httpPeer(async (request, response) => {
    if (request.url?.includes('/state/')) {
      json(response, { errcode: 'M_NOT_FOUND' }, 404)
      return
    }
    sent.push(await body(request))
    json(response, { event_id: '$reply' })
  })

  const plugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })
  await harness(
    plugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`
  )
  expect(
    await plugin.send({
      ...input({
        channel: 'matrix',
        accountId: 'bot',
        chatId: room,
        threadId: thread,
        replyToId: '$selected-message',
        data: { homeserver: peer.base, userId: '@bot:local.test' }
      }),
      reply: { requestId: 'request-1', kind: 'final' }
    })
  ).toEqual({ status: 'sent', receipt: { platformMessageId: '$reply' } })
  expect(sent).toEqual([
    expect.objectContaining({
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: thread,
        is_falling_back: false,
        'm.in_reply_to': { event_id: '$selected-message' }
      }
    })
  ])
})

// Encrypted attachment wire fields are defined at
// https://spec.matrix.org/v1.15/client-server-api/#sending-encrypted-attachments
// Unsupported encryption must not prevent later plain messages from reaching SQLite.
it('rejects an encrypted attachment and durably advances past it to subsequent text', async () => {
  const observation = observations()
  let downloads = 0

  const peer = await httpPeer((request, response) => {
    if (request.url?.includes('/media/download/')) {
      downloads += 1
      response.end()
      return
    }
    json(response, {
      next_batch: 'after-encrypted-attachment',
      rooms: {
        join: {
          [room]: {
            timeline: {
              events: [
                {
                  event_id: '$encrypted-attachment',
                  sender: user,
                  type: 'm.room.message',
                  content: {
                    msgtype: 'm.image',
                    body: 'secret.png',
                    file: {
                      url: 'mxc://example.org/encrypted-image',
                      key: {
                        kty: 'oct',
                        key_ops: ['encrypt', 'decrypt'],
                        alg: 'A256CTR',
                        k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                        ext: true
                      },
                      iv: 'AAAAAAAAAAAAAAAAAAAAAA',
                      hashes: {
                        sha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
                      },
                      v: 'v2'
                    }
                  }
                },
                event('$after-encrypted-attachment', 'plain message')
              ]
            }
          }
        }
      }
    })
  })

  const plugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`,
    { observe: observation.observe }
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (
        await fixture.storage.getState(
          { pluginId: 'channel-matrix', ownerId: 'bot' },
          'sync'
        )
      )?.value === 'after-encrypted-attachment'
  )
  await plugin.stop?.()
  const records = await fixture.storage.listInbound({ limit: 10 })
  expect(records).toHaveLength(1)
  expect(records[0]?.snapshot.text).toBe('plain message')
  expect(records[0]?.snapshot.source.eventId).toBe(
    '$after-encrypted-attachment'
  )
  expect(downloads).toBe(0)
  expect(observation.logs).toContainEqual({
    event: 'operation.failed',
    fields: { operation: 'receive', errorCode: 'encrypted_unsupported' }
  })
})

// State lookup 404 establishes absent state only with the native M_NOT_FOUND code:
// https://spec.matrix.org/v1.15/client-server-api/#get_matrixclientv3roomsroomidstateeventtypestatekey
// OpenClaw c3fcd1554c3405c942bc03ec85fcbac8a0bb12a3,
// Extensions/matrix/src/matrix/sdk/client-core.ts:getMessageWireEventType verifies both.
it.each([{}, { errcode: 'M_UNRECOGNIZED' }])(
  'does not send plaintext when encryption preflight has an ambiguous 404 (%j)',
  async (error) => {
    let sends = 0

    const peer = await httpPeer((request, response) => {
      if (request.url?.includes('/state/')) {
        json(response, error, 404)
        return
      }
      sends += 1
      json(response, { event_id: '$must-not-send' })
    })

    const plugin = createMatrixChannel({ MATRIX_TOKEN: 'token' })
    await harness(
      plugin,
      config(peer.base),
      [{ chatId: room }],
      [user],
      `${peer.base}/dispatch`
    )
    expect(
      await plugin.send(
        input({
          channel: 'matrix',
          accountId: 'bot',
          chatId: room,
          data: { homeserver: peer.base, userId: '@bot:local.test' }
        })
      )
    ).toEqual({ status: 'retryable', errorCode: 'encryption_check_failed' })
    expect(sends).toBe(0)
  }
)
