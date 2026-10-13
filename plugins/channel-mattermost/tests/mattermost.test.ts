import type { Server } from 'ws'
import type { SendInput } from '@relanox/sdk'
import { expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import {
  body,
  cleanup,
  databaseFile,
  harness,
  httpPeer,
  json,
  observations,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import { createMattermostChannel } from '../src/index.js'

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
    seq: 2
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

function sockets(peer: Awaited<ReturnType<typeof httpPeer>>): Server {
  const server = new WebSocketServer({
    server: peer.server,
    path: '/api/v4/websocket'
  })

  cleanup(async () => {
    for (const socket of server.clients) {
      socket.terminate()
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })
  return server
}

it('receives native /me text at the channel and thread while filtering system posts', async () => {
  const peer = await httpPeer((_request, response) => {
    json(response, {})
  })

  const server = sockets(peer)
  server.on('connection', (socket) => {
    socket.once('message', () => {
      socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))
      // Mattermost 2b64fd09d3839007887662c191bd5d7af113a385:
      // Server/public/model/post.go PostTypeMe and Post, and
      // Server/public/model/websocket_message.go WebsocketEventPosted.
      // /me is a native text post type; system_join_channel is a system event.
      for (const [id, type, rootId] of [
        ['action-channel', 'me', ''],
        ['action-thread', 'me', 'root'],
        ['system-post', 'system_join_channel', ''],
        ['custom-post', 'custom_unknown', '']
      ]) {
        socket.send(
          JSON.stringify({
            event: 'posted',
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

it('resumes a native bounded WebSocket stream after reopening SQLite and waits for authentication', async () => {
  const upgrades: {
    url: string | undefined
    authorization: string | undefined
  }[] = []

  let identity = 'self-bot'

  const peer = await httpPeer(
    (_request, response) => {
      json(response, {})
    },
    (_request, response) => {
      json(response, { id: identity })
    }
  )

  const server = sockets(peer)
  // Primary Mattermost 2b64fd09d3839007887662c191bd5d7af113a385:
  // Server/channels/api4/websocket.go authenticated upgrade query;
  // Server/channels/app/platform/web_conn.go PopulateWebConnConfig and
  // WritePump replay the next sequence before authentication_challenge reply.
  // Fixed wire fixtures describe a retained server cache, not historical backfill.
  const connectionId = 'abcdefghijklmnopqrstuvwxyz'
  let releaseAuthentication: (() => void) | undefined

  function authenticate(): void {
    if (!releaseAuthentication) {
      throw new Error('Missing authentication challenge')
    }
    releaseAuthentication()
  }

  server.on('connection', (socket, request) => {
    upgrades.push({
      url: request.url,
      authorization: request.headers.authorization
    })
    if (upgrades.length !== 2) {
      socket.send(
        JSON.stringify({
          event: 'hello',
          seq: 0,
          data: { connection_id: connectionId }
        })
      )
      socket.send(
        JSON.stringify({
          ...posted(
            upgrades.length === 1
              ? 'saved-before-restart'
              : 'after-identity-rotation'
          ),
          seq: 1
        })
      )
    } else {
      socket.send(
        JSON.stringify({ ...posted('replayed-after-restart'), seq: 2 })
      )
    }
    socket.once('message', () => {
      releaseAuthentication = (): void => {
        socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))
      }
    })
  })
  const filename = await databaseFile()
  const first = createMattermostChannel({ MATTERMOST_TOKEN: 'token' })

  const initial = await harness(
    first,
    config(peer.base),
    [{ chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`,
    { filename }
  )

  await first.start?.(new AbortController().signal)
  await waitFor(() => releaseAuthentication !== undefined)
  expect(await initial.storage.listInbound({ limit: 10 })).toEqual([])
  authenticate()
  await waitFor(
    async () => (await initial.storage.listInbound({ limit: 10 })).length === 1
  )
  await first.stop?.()
  await initial.storage.close()
  releaseAuthentication = undefined
  const second = createMattermostChannel({ MATTERMOST_TOKEN: 'token' })

  const restored = await harness(
    second,
    config(peer.base),
    [{ chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`,
    { filename }
  )

  await second.start?.(new AbortController().signal)
  await waitFor(() => releaseAuthentication !== undefined)
  expect(await restored.storage.listInbound({ limit: 10 })).toHaveLength(1)
  authenticate()
  await waitFor(
    async () => (await restored.storage.listInbound({ limit: 10 })).length === 2
  )
  await second.stop?.()
  expect(upgrades).toEqual([
    { url: '/api/v4/websocket', authorization: 'Bearer token' },
    {
      url: '/api/v4/websocket?connection_id=abcdefghijklmnopqrstuvwxyz&sequence_number=2',
      authorization: 'Bearer token'
    }
  ])
  expect(
    (await restored.storage.listInbound({ limit: 10 }))
      .map((request) => request.snapshot.source.eventId)
      .toSorted()
  ).toEqual(['replayed-after-restart', 'saved-before-restart'])
  await restored.storage.close()
  identity = 'rotated-bot'
  releaseAuthentication = undefined
  const rotated = createMattermostChannel({ MATTERMOST_TOKEN: 'rotated-token' })

  const rotation = await harness(
    rotated,
    config(peer.base),
    [{ chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`,
    { filename }
  )

  await rotated.start?.(new AbortController().signal)
  await waitFor(() => releaseAuthentication !== undefined)
  expect(upgrades[2]).toEqual({
    url: '/api/v4/websocket',
    authorization: 'Bearer rotated-token'
  })
  authenticate()
  await waitFor(
    async () => (await rotation.storage.listInbound({ limit: 10 })).length === 3
  )
  await rotated.stop?.()
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

  const server = sockets(peer)
  server.on('connection', (socket) => {
    socket.once('message', (bytes) => {
      if (!Buffer.isBuffer(bytes)) {
        throw new TypeError('Unexpected peer frame')
      }
      challenges.push(JSON.parse(bytes.toString('utf8')) as unknown)
      socket.send(JSON.stringify({ status: 'OK', seq_reply: 1, data: {} }))
      for (const frame of [
        posted('post-1'),
        posted('post-1'),
        posted('post-own', 'self-bot'),
        posted('post-blocked', 'mallory'),
        posted('post-unbound', 'alice', 'unbound')
      ]) {
        socket.send(JSON.stringify(frame))
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
      authorization: 'Bearer mattermost-access-secret',
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

it('diagnoses failed authentication and refuses posted frames before an OK response', async () => {
  const observation = observations()

  const peer = await httpPeer((_request, response) => {
    json(response, {})
  })

  const server = sockets(peer)
  server.on('connection', (socket) => {
    socket.once('message', () => {
      socket.send(
        JSON.stringify({
          status: 'FAIL',
          seq_reply: 1,
          error: { id: 'unauthorized' }
        })
      )
      socket.send(JSON.stringify(posted('unauthenticated')))
    })
  })
  const plugin = createMattermostChannel({ MATTERMOST_TOKEN: 'invalid' })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'channel', threadId: 'root' }],
    ['alice'],
    `${peer.base}/dispatch`,
    { observe: observation.observe }
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(() =>
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'authentication_failed'
    )
  )
  await plugin.stop?.()
  expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([])
  expect((await fixture.runtime.status()).connections['channels/bot']).toBe(
    'disconnected'
  )
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

  const server = sockets(peer)
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

it.each([
  [429, 'retryable'],
  [403, 'rejected'],
  [503, 'unknown']
] as const)('maps REST HTTP %i conservatively', async (status, outcome) => {
  const peer = await httpPeer((_request, response) => {
    response.setHeader('Retry-After', '7')
    json(response, {}, status)
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
    expect(result.retryAfterMs).toBe(7000)
  }
})

it('validates protocol JSON instead of admitting malformed nested posts', async () => {
  const observation = observations()

  const peer = await httpPeer((_request, response) => {
    json(response, {})
  })

  const server = sockets(peer)
  server.on('connection', (socket) => {
    socket.once('message', () => {
      socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))
      socket.send(
        JSON.stringify({ event: 'posted', data: { post: '{invalid' } })
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
