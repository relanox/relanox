import type { SendInput } from '@relanox/sdk'
import { expect, it } from 'vitest'
import { z } from 'zod'
import {
  body,
  cleanup,
  harness,
  httpPeer,
  json,
  observations,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import { createMattermostChannel } from '../src/index.js'
import { websocketPeer } from './peer.js'

function config(base: string): {
  serverUrl: string

  token: { env: string }
  allowInsecureLocalhost: boolean
} {
  return {
    serverUrl: base,
    token: { env: 'MATTERMOST_TOKEN' },
    allowInsecureLocalhost: true
  }
}

function posted(
  id: string,
  userId = 'alice',
  channelId = 'channel',
  rootId = 'root'
): { event: string; data: { post: string }; seq: number } {
  return {
    event: 'posted',
    data: {
      post: JSON.stringify({
        id,
        user_id: userId,
        channel_id: channelId,
        root_id: rootId,
        message: 'question',
        create_at: 1_800_000_000_000,
        type: ''
      })
    },
    seq: 1
  }
}

function sendInput(base: string): SendInput {
  return {
    deliveryId: 'delivery',
    channelId: 'request',
    target: {
      channel: 'mattermost',
      accountId: 'bot',
      chatId: 'channel',
      threadId: 'root',
      data: { serverUrl: base, botUserId: 'self-bot' }
    },
    chunk: { text: 'answer', idempotencyKey: 'delivery:0', state: null },
    chunkIndex: 0,
    signal: new AbortController().signal
  }
}

it('receives native /me text at the channel and thread while filtering system posts', async () => {
  const peer = await httpPeer((_request, response) => {
    json(response, {})
  })

  const server = websocketPeer(peer)
  server.on('connection', (socket) => {
    socket.once('message', () => {
      socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))
      // Mattermost 2b64fd09d3839007887662c191bd5d7af113a385:
      // Server/public/model/post.go PostTypeMe and Post, and
      // Server/public/model/websocket_message.go WebsocketEventPosted.
      // /me is a native text post type; system_join_channel is a system event.
      for (const [index, [id, type, rootId]] of [
        ['action-channel', 'me', ''],
        ['action-thread', 'me', 'root'],
        ['system-post', 'system_join_channel', ''],
        ['custom-post', 'custom_unknown', '']
      ].entries()) {
        socket.send(
          JSON.stringify({
            event: 'posted',
            seq: index + 1,
            data: {
              post: JSON.stringify({
                id,
                type,
                root_id: rootId,
                user_id: 'alice',
                channel_id: 'channel',
                message: 'waves hello',
                create_at: 1_800_000_000_000,
                file_ids: []
              })
            }
          })
        )
      }
    })
  })
  const plugin = createMattermostChannel({ MATTERMOST_TOKEN: 'token' })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'channel' }, { chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () => (await fixture.storage.listInbound({ limit: 10 })).length === 2
  )
  await plugin.stop?.()
  const requests = await fixture.storage.listInbound({ limit: 10 })
  expect(
    requests
      .map((request) => ({
        eventId: request.snapshot.source.eventId,
        text: request.snapshot.text,
        chatId: request.snapshot.target.chatId,
        threadId: request.snapshot.target.threadId
      }))
      .toSorted((left, right) => left.eventId.localeCompare(right.eventId))
  ).toEqual([
    {
      eventId: 'action-channel',
      text: 'waves hello',
      chatId: 'channel',
      threadId: undefined
    },
    {
      eventId: 'action-thread',
      text: 'waves hello',
      chatId: 'channel',
      threadId: 'root'
    }
  ])
})

// SDK cursor state is memory-only; Core's accepted work remains durable.
// Exercises an actual SQLite reopen and native SDK REST post, without replay peers.
it('recovers accepted input and a queued thread reply after replacing the SDK client', async () => {
  const sent: unknown[] = []
  const dispatches: unknown[] = []

  const peer = await httpPeer(async (request, response) => {
    const payload = await body(request)
    if (request.url === '/api/v4/posts') {
      sent.push(payload)
      json(response, { id: 'restored-reply' }, 201)
    } else {
      dispatches.push(payload)
      json(response, {})
    }
  })

  const server = websocketPeer(peer)
  server.on('connection', (socket) => {
    socket.once('message', () => {
      socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))
      socket.send(JSON.stringify(posted('saved-before-restart')))
    })
  })
  const firstPlugin = createMattermostChannel({ MATTERMOST_TOKEN: 'token' })

  const first = await harness(
    firstPlugin,
    config(peer.base),
    [{ chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`
  )

  await firstPlugin.start?.(new AbortController().signal)
  await waitFor(
    async () => (await first.storage.listInbound({ limit: 10 })).length === 1
  )
  await firstPlugin.stop?.()
  const record = (await first.storage.listInbound({ limit: 10 }))[0]
  if (!record) {
    throw new Error('Missing accepted request')
  }
  const reply = await first.sendReply(record.snapshot.requestId, 'saved answer')
  await first.storage.close()
  const nextPlugin = createMattermostChannel({ MATTERMOST_TOKEN: 'token' })

  const next = await harness(
    nextPlugin,
    config(peer.base),
    [{ chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`,
    { filename: first.filename }
  )

  await next.runtime.processDue()
  expect(dispatches).toEqual([
    { channel: record.snapshot.channel.id, text: 'question' }
  ])
  expect(sent).toEqual([
    { channel_id: 'channel', root_id: 'root', message: 'saved answer' }
  ])
  expect((await next.storage.getOutbound(reply.deliveryId))?.status).toBe(
    'sent'
  )
})

it('authenticates WebSocket, deduplicates posted frames across reconnect and sends delayed thread posts', async () => {
  const sent: { data: unknown; authorization: string | undefined }[] = []
  const dispatches: unknown[] = []
  const challenges: unknown[] = []

  const peer = await httpPeer(async (request, response) => {
    const data = await body(request)
    if (request.url === '/api/v4/posts') {
      sent.push({ data, authorization: request.headers.authorization })
      json(response, { id: 'outbound-post' }, 201)
    } else {
      dispatches.push(data)
      json(response, {})
    }
  })

  const server = websocketPeer(peer)
  server.on('connection', (socket, request) => {
    const since = Number(
      new URL(request.url ?? '/', peer.base).searchParams.get(
        'sequence_number'
      ) ?? 0
    )

    socket.once('message', (bytes) => {
      if (!Buffer.isBuffer(bytes)) {
        throw new TypeError('Unexpected peer frame')
      }
      challenges.push(JSON.parse(bytes.toString('utf8')) as unknown)
      socket.send(JSON.stringify({ status: 'OK', seq_reply: 1, data: {} }))
      for (const [index, frame] of [
        posted('post-1'),
        posted('post-1'),
        posted('post-own', 'self-bot'),
        posted('post-blocked', 'mallory'),
        posted('post-unbound', 'alice', 'unbound')
      ].entries()) {
        socket.send(
          JSON.stringify({ ...frame, seq: Math.max(1, since) + index })
        )
      }
    })
  })

  const plugin = createMattermostChannel({
    MATTERMOST_TOKEN: 'mattermost-access-secret'
  })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () => (await fixture.storage.listInbound({ limit: 10 })).length === 1
  )
  for (const socket of server.clients) {
    socket.terminate()
  }
  await waitFor(() => challenges.length >= 2)
  await plugin.stop?.()
  expect(challenges[0]).toEqual({
    seq: 1,
    action: 'authentication_challenge',
    data: { token: 'mattermost-access-secret' }
  })
  const requests = await fixture.storage.listInbound({ limit: 10 })
  expect(requests).toHaveLength(1)
  const request = requests[0]
  if (!request) {
    throw new Error('Missing request')
  }
  expect(request.snapshot.target).toEqual({
    channel: 'mattermost',
    accountId: 'bot',
    chatId: 'channel',
    threadId: 'root',
    replyToId: 'post-1',
    data: { serverUrl: peer.base, botUserId: 'self-bot' }
  })
  expect(JSON.stringify(request.snapshot)).not.toContain(
    'mattermost-access-secret'
  )
  await fixture.runtime.processDue()
  expect(dispatches).toEqual([
    { channel: request.snapshot.channel.id, text: 'question' }
  ])

  const completed = await fixture.sendReply(
    request.snapshot.requestId,
    '**answer** [link](https://example.com)'
  )

  await fixture.runtime.processDue()
  expect(sent).toEqual([
    {
      authorization: expect.stringMatching(
        /^Bearer mattermost-access-secret$/iu
      ) as unknown,
      data: {
        channel_id: 'channel',
        message: '**answer** [link](https://example.com)',
        root_id: 'root'
      }
    }
  ])
  expect(
    (await fixture.storage.getOutbound(completed.deliveryId))?.receipts
  ).toEqual([{ platformMessageId: 'outbound-post' }])
  expect(plugin.capabilities.idempotentSend).toBe(false)
})

it('refuses an SDK identity authentication failure before opening the event connection', async () => {
  let connections = 0

  const peer = await httpPeer(
    (_request, response) => {
      json(response, {})
    },
    (_request, response) => {
      json(
        response,
        {
          id: 'api.context.session_expired.app_error',
          message: 'Unauthorized',
          status_code: 401
        },
        401
      )
    }
  )

  const server = websocketPeer(peer)
  server.on('connection', () => {
    connections += 1
  })
  const plugin = createMattermostChannel({ MATTERMOST_TOKEN: 'invalid' })
  await expect(
    harness(
      plugin,
      config(peer.base),
      [{ chatId: 'channel' }],
      ['alice'],
      `${peer.base}/dispatch`
    )
  ).rejects.toThrow()
  expect(connections).toBe(0)
})

// Official WebSocketClient 11.9.0 close() only closes an OPEN socket. Core stop
// Must also release a handshake in progress. Existing receive tests stop after
// An authenticated post; a real delayed peer needs no test-only production seam.
it('closes an unfinished WebSocket handshake when Core stops the SDK client', async () => {
  let upgraded = false
  let closed = false

  const peer = await httpPeer((_request, response) => {
    json(response, {})
  })

  peer.server.on('upgrade', (_request, socket) => {
    upgraded = true
    socket.resume()
    socket.on('end', () => {
      socket.end()
    })
    socket.on('close', () => {
      closed = true
    })
    cleanup(async () => {
      socket.destroy()
    })
  })
  const plugin = createMattermostChannel({ MATTERMOST_TOKEN: 'token' })
  await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'channel' }],
    ['alice'],
    `${peer.base}/dispatch`
  )
  await plugin.start?.(new AbortController().signal)
  await waitFor(() => upgraded)
  await plugin.stop?.()
  await waitFor(() => closed)
  expect(closed).toBe(true)
})

it('keeps an uncertain REST POST unknown without automatic resend', async () => {
  let sends = 0

  const peer = await httpPeer(async (request, response) => {
    if (request.url === '/api/v4/posts') {
      await body(request)
      sends += 1
      request.socket.destroy()
      return
    }
    json(response, {})
  })

  const server = websocketPeer(peer)
  server.on('connection', (socket) => {
    socket.once('message', () => {
      socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))
      socket.send(JSON.stringify(posted('ambiguous')))
    })
  })
  const plugin = createMattermostChannel({ MATTERMOST_TOKEN: 'token' })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () => (await fixture.storage.listInbound({ limit: 10 })).length === 1
  )
  await plugin.stop?.()
  const request = (await fixture.storage.listInbound({ limit: 10 }))[0]
  if (!request) {
    throw new Error('Missing request')
  }

  const completed = await fixture.sendReply(
    request.snapshot.requestId,
    '**answer** [link](https://example.com)'
  )

  await fixture.runtime.processDue()
  expect(
    (await fixture.storage.getOutbound(completed.deliveryId))?.status
  ).toBe('unknown')
  await fixture.runtime.processDue()
  expect(sends).toBe(1)
})

// Official @mattermost/client 11.9.0 Client4.doFetchWithResponse/ClientError
// Preserves ServerError.status_code; it does not expose Retry-After headers.
it.each([
  [429, 'retryable'],
  [413, 'rejected'],
  [403, 'rejected'],
  [503, 'unknown']
] as const)('maps REST HTTP %i conservatively', async (status, outcome) => {
  const peer = await httpPeer((_request, response) => {
    response.setHeader('Retry-After', '7')
    json(
      response,
      {
        id: 'api.test.error',
        message: 'Native server refusal',
        status_code: status
      },
      status
    )
  })

  const plugin = createMattermostChannel({ MATTERMOST_TOKEN: 'token' })
  await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`
  )
  const result = await plugin.send(sendInput(peer.base))
  expect(result.status).toBe(outcome)
  if (result.status === 'retryable') {
    expect(result.retryAfterMs).toBe(1000)
  }
})

it('validates protocol JSON instead of admitting malformed nested posts', async () => {
  const observation = observations()

  const peer = await httpPeer((_request, response) => {
    json(response, {})
  })

  const server = websocketPeer(peer)
  server.on('connection', (socket) => {
    socket.once('message', () => {
      socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))
      socket.send(
        JSON.stringify({ event: 'posted', seq: 1, data: { post: '{invalid' } })
      )
    })
  })
  const plugin = createMattermostChannel({ MATTERMOST_TOKEN: 'token' })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'channel' }],
    ['alice'],
    `${peer.base}/dispatch`,
    { observe: observation.observe }
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(() =>
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'receive_failed'
    )
  )
  await plugin.stop?.()
  expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([])
  expect(() =>
    plugin.validateConfig({ ...config(peer.base), token: 'plaintext' })
  ).toThrow(z.ZodError)
  expect(() => plugin.validateConfig(config('http://remote.example'))).toThrow()
})
