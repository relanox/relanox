import {
  installPeerNetwork,
  outboundRequests
} from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { wireText } from '../../channel-wecom/src/transport.js'
import { z } from 'zod'
import {
  assemble,
  peer,
  records,
  sendInput,
  temporaryDatabase
} from '../../channel-wecom/tests/test-support.js'
import { createQqChannel } from '../src/index.js'

installPeerNetwork()

const createEvent = (
  id: string,
  group = false,
  extra: Record<string, unknown> = {}
): {
  group_openid?: string
  id: string
  content: string
  timestamp: string
  message_type: number
  author:
    | { member_openid: string; user_openid?: never }
    | { user_openid: string; member_openid?: never }
} => ({
  id,
  content: 'question',
  timestamp: new Date().toISOString(),
  message_type: 0,
  author: group ? { member_openid: 'member' } : { user_openid: 'user' },
  ...(group ? { group_openid: 'group' } : {}),
  ...extra
})

const frame = (s: number, t: string, d: unknown): string =>
  JSON.stringify({ op: 0, s, t, d })

test('QQ authenticates latest token protocol, receives C2C/group text and resumes committed cursor before RESUMED', async () => {
  vi.stubEnv('QQ_SECRET', 'secret')
  let address = ''

  const remote = await peer(
    (request) => {
      if (request.path === '/app/getAppAccessToken') {
        return { body: { access_token: 'cloud-token', expires_in: '7200' } }
      }
      if (request.path === '/gateway') {
        return { body: { url: address } }
      }
      return { body: { id: 'sent' } }
    },
    (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }))
      socket.on('message', (data) => {
        const received = z
          .object({ op: z.number() })
          .parse(JSON.parse(wireText(data)))

        if (received.op === 2) {
          socket.send(frame(1, 'READY', { session_id: 'session' }))
        }
        if (received.op === 1) {
          socket.send(JSON.stringify({ op: 11 }))
        }
        if (received.op === 6) {
          socket.send(frame(7, 'C2C_MESSAGE_CREATE', createEvent('replayed')))
          socket.send(frame(8, 'RESUMED', ''))
        }
      })
    }
  )

  address = remote.ws
  const plugin = createQqChannel()

  const host = await assemble(
    plugin,
    {
      appId: 'app',
      clientSecret: { env: 'QQ_SECRET' }
    },
    [
      { chatId: 'user', senderId: 'user' },
      { chatId: 'group', senderId: 'member' }
    ]
  )

  await host.start()
  await expect.poll(() => remote.frames.length).toBeGreaterThan(0)
  expect(remote.frames[0]).toEqual({
    op: 2,
    d: {
      token: 'QQBot cloud-token',
      intents: 33_554_432,
      shard: [0, 1],
      properties: {}
    }
  })
  expect(remote.requests[0]?.body).toEqual({
    appId: 'app',
    clientSecret: 'secret'
  })
  expect(remote.requests[1]?.headers.authorization).toBe('QQBot cloud-token')
  const socket = remote.sockets[0]
  if (!socket) {
    throw new Error('Peer not connected')
  }
  socket.send(
    frame(
      2,
      'C2C_MESSAGE_CREATE',
      createEvent('c2c', false, {
        message_scene: { ext: ['msg_idx=one', 'auth_token=do-not-persist'] }
      })
    )
  )
  socket.send(
    frame(
      3,
      'C2C_MESSAGE_CREATE',
      createEvent('c2c', false, { message_scene: { ext: ['msg_idx=one'] } })
    )
  )
  socket.send(
    frame(4, 'GROUP_AT_MESSAGE_CREATE', createEvent('group-msg', true))
  )
  socket.send(
    frame(
      5,
      'C2C_MESSAGE_CREATE',
      createEvent('media', false, {
        attachments: [{ filename: 'malformed.bin' }]
      })
    )
  )
  socket.send(
    frame(
      6,
      'C2C_MESSAGE_CREATE',
      createEvent('bot-message', false, {
        author: { user_openid: 'user', bot: true }
      })
    )
  )
  await expect.poll(async () => (await records(host.storage)).length).toBe(2)
  expect(
    (await records(host.storage))
      .map((record) => record.snapshot.target.chatId)
      .toSorted()
  ).toEqual(['group', 'user'])
  expect(JSON.stringify(await records(host.storage))).not.toContain(
    'do-not-persist'
  )
  await expect.poll(() => remote.frames).toContainEqual({ op: 1, d: 6 })
  socket.close(4009)
  await expect.poll(() => remote.sockets.length, { timeout: 4000 }).toBe(2)
  await expect
    .poll(() => remote.frames)
    .toContainEqual({
      op: 6,
      d: { token: 'QQBot cloud-token', session_id: 'session', seq: 6 }
    })
  await expect.poll(async () => (await records(host.storage)).length).toBe(3)
  expect(
    (await records(host.storage)).some(
      (record) => record.snapshot.target.replyToId === 'replayed'
    )
  ).toBe(true)
  host.controller.abort()
  await new Promise((resolve) => {
    setTimeout(resolve, 1200)
  })
  expect(remote.sockets).toHaveLength(2)
})

test('QQ reserves sequences using real SQLite CAS, reuses them after reopen and preserves 429 retries', async () => {
  vi.stubEnv('QQ_SECRET', 'secret')
  let sends = 0

  const remote = await peer((request) => {
    if (request.path === '/app/getAppAccessToken') {
      return { body: { access_token: 'token', expires_in: 7200 } }
    }
    sends++
    return sends === 1
      ? { status: 429, headers: { 'retry-after': '1' } }
      : { body: { id: `sent-${sends}` } }
  })

  const filename = await temporaryDatabase()

  const config = {
    appId: 'app',
    clientSecret: { env: 'QQ_SECRET' }
  }

  const first = createQqChannel()

  const host = await assemble(
    first,
    config,
    [{ chatId: 'group', senderId: 'member' }],
    filename
  )

  const target = {
    type: 'group',
    msgId: 'incoming',
    messageAt: Date.now(),
    scope: { appId: 'app', apiBase: 'https://api.sgroup.qq.com/' }
  }

  const a = sendInput('qq', 'group', target, 'arbitrary-key-a')
  const b = sendInput('qq', 'group', target, 'arbitrary-key-b')
  const results = await Promise.all([first.send(a), first.send(b)])
  expect(results.map((result) => result.status).toSorted()).toEqual([
    'retryable',
    'sent'
  ])

  const before = remote.requests.filter((request) =>
    request.path.endsWith('/messages')
  )

  expect(before.map((request) => request.body)).toEqual([
    { content: 'hello_*世界', msg_type: 0, msg_id: 'incoming', msg_seq: 1 },
    { content: 'hello_*世界', msg_type: 0, msg_id: 'incoming', msg_seq: 2 }
  ])
  await host.storage.close()
  const restarted = createQqChannel()
  await assemble(
    restarted,
    config,
    [{ chatId: 'group', senderId: 'member' }],
    filename
  )
  expect((await restarted.send(a)).status).toBe('sent')
  expect(
    (await restarted.send(sendInput('qq', 'group', target, 'arbitrary-key-c')))
      .status
  ).toBe('sent')
  expect(
    remote.requests
      .filter((request) => request.path.endsWith('/messages'))
      .map((request) => request.body)
  ).toEqual([
    { content: 'hello_*世界', msg_type: 0, msg_id: 'incoming', msg_seq: 1 },
    { content: 'hello_*世界', msg_type: 0, msg_id: 'incoming', msg_seq: 2 },
    { content: 'hello_*世界', msg_type: 0, msg_id: 'incoming', msg_seq: 1 },
    { content: 'hello_*世界', msg_type: 0, msg_id: 'incoming', msg_seq: 3 }
  ])
  expect(before[0]?.headers.authorization).toBe('QQBot token')
  expect(first.capabilities.idempotentSend).toBe(false)
})

test.each([
  { type: 'c2c', ageMs: 30 * 60_000, expected: 'sent' },
  { type: 'c2c', ageMs: 61 * 60_000, expected: 'rejected' },
  { type: 'group', ageMs: 6 * 60_000, expected: 'rejected' }
])(
  'QQ applies documented passive $type window at $ageMs milliseconds',
  async ({ type, ageMs, expected }) => {
    vi.stubEnv('QQ_SECRET', 'secret')

    const remote = await peer((request) =>
      request.path === '/app/getAppAccessToken'
        ? { body: { access_token: 'token', expires_in: 7200 } }
        : { body: { id: 'sent' } }
    )

    const plugin = createQqChannel()
    await assemble(
      plugin,
      {
        appId: 'app',
        clientSecret: { env: 'QQ_SECRET' }
      },
      [{ chatId: 'user', senderId: 'user' }]
    )
    expect(
      (
        await plugin.send(
          sendInput('qq', 'user', {
            type,
            msgId: 'incoming',
            messageAt: Date.now() - ageMs,
            scope: { appId: 'app', apiBase: 'https://api.sgroup.qq.com/' }
          })
        )
      ).status
    ).toBe(expected)
    expect(
      remote.requests.filter((request) => request.path.endsWith('/messages'))
    ).toHaveLength(expected === 'sent' ? 1 : 0)
  }
)

test.each([
  { type: 'c2c', max: 4 },
  { type: 'group', max: 5 }
])(
  'QQ bounds $type passive replies and requires permission for proactive fallback',
  async ({ type, max }) => {
    vi.stubEnv('QQ_SECRET', 'secret')

    const remote = await peer((request) =>
      request.path === '/app/getAppAccessToken'
        ? { body: { access_token: 'token', expires_in: 7200 } }
        : { body: { id: 'sent' } }
    )

    const plugin = createQqChannel()
    await assemble(
      plugin,
      {
        appId: 'app',
        clientSecret: { env: 'QQ_SECRET' }
      },
      [{ chatId: 'user', senderId: 'user' }]
    )

    const target = {
      type,
      msgId: 'incoming',
      messageAt: Date.now(),
      scope: { appId: 'app', apiBase: 'https://api.sgroup.qq.com/' }
    }

    for (let index = 0; index < max; index++) {
      expect(
        (await plugin.send(sendInput('qq', 'user', target, `chunk:${index}`)))
          .status
      ).toBe('sent')
    }
    expect(
      await plugin.send(sendInput('qq', 'user', target, `chunk:${max}`))
    ).toEqual({
      status: 'rejected',
      errorCode: 'passive_reply_limit'
    })
    expect(
      remote.requests.filter((request) => request.path.endsWith('/messages'))
    ).toHaveLength(max)
    const allowed = createQqChannel()
    await assemble(
      allowed,
      {
        appId: 'app',
        clientSecret: { env: 'QQ_SECRET' },

        allowProactive: true
      },
      [{ chatId: 'user', senderId: 'user' }]
    )
    expect(
      (
        await allowed.send(
          sendInput('qq', 'user', {
            ...target,
            messageAt: Date.now() - 7_200_000,
            scope: { appId: 'app', apiBase: 'https://api.sgroup.qq.com/' }
          })
        )
      ).status
    ).toBe('sent')
    expect(remote.requests.at(-1)?.body).toEqual({
      content: 'hello_*世界',
      msg_type: 0
    })
  }
)

test.each([
  {
    reply: { status: 400, body: { code: 40_034_128 } },
    result: { status: 'rejected', errorCode: 'qq_40034128' }
  },
  {
    reply: { body: { code: 40_034_105 } },
    result: { status: 'rejected', errorCode: 'qq_40034105' }
  },
  {
    reply: { status: 503, body: { code: 50_055_001 } },
    result: {
      status: 'retryable',
      errorCode: 'qq_50055001',
      retryAfterMs: 1000
    }
  },
  {
    reply: { body: { code: 40_054_005 } },
    result: { status: 'unknown', errorCode: 'qq_duplicate_effect' }
  },
  {
    reply: { status: 503 },
    result: { status: 'unknown', errorCode: 'http_503' }
  },
  {
    reply: { disconnect: true },
    result: { status: 'unknown', errorCode: 'transport_uncertain' }
  }
])(
  'QQ preserves $result.errorCode instead of blind retry or false success',
  async ({ reply, result }) => {
    vi.stubEnv('QQ_SECRET', 'secret')

    await peer((request) =>
      request.path === '/app/getAppAccessToken'
        ? { body: { access_token: 'token', expires_in: 7200 } }
        : reply
    )

    const plugin = createQqChannel()
    await assemble(
      plugin,
      {
        appId: 'app',
        clientSecret: { env: 'QQ_SECRET' },

        allowProactive: true
      },
      [{ chatId: 'user', senderId: 'user' }]
    )
    expect(
      await plugin.send(
        sendInput('qq', 'user', {
          type: 'c2c',
          msgId: 'incoming',
          messageAt: Date.now() - 7_200_000,
          scope: { appId: 'app', apiBase: 'https://api.sgroup.qq.com/' }
        })
      )
    ).toEqual(result)
  }
)

test('QQ rejects deprecated static token configuration and remote insecure API bases', () => {
  const plugin = createQqChannel()
  expect(() =>
    plugin.validateConfig({ appId: 'app', token: 'old-bot-token' })
  ).toThrow()
  expect(() =>
    plugin.validateConfig({
      appId: 'app',
      clientSecret: { env: 'QQ_SECRET' },
      apiBase: 'http://remote.example'
    })
  ).toThrow()
})

test('QQ resumes before a failed SQLite write even with later dispatches already buffered', async () => {
  vi.stubEnv('QQ_SECRET', 'secret')
  let address = ''

  const remote = await peer(
    (request) =>
      request.path === '/app/getAppAccessToken'
        ? { body: { access_token: 'token', expires_in: 7200 } }
        : { body: { url: address } },
    (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }))
      socket.on('message', (data) => {
        const received = z
          .object({ op: z.number() })
          .parse(JSON.parse(wireText(data)))

        if (received.op === 2) {
          socket.send(frame(1, 'READY', { session_id: 'session' }))
        }
        if (received.op === 1) {
          socket.send(JSON.stringify({ op: 11 }))
        }
        if (received.op === 6) {
          socket.send(
            frame(2, 'C2C_MESSAGE_CREATE', createEvent('failed-write'))
          )
          socket.send(
            frame(3, 'C2C_MESSAGE_CREATE', createEvent('next-message'))
          )
          socket.send(frame(4, 'RESUMED', ''))
        }
      })
    }
  )

  address = remote.ws
  const filename = await temporaryDatabase()

  const host = await assemble(
    createQqChannel(),
    {
      appId: 'app',
      clientSecret: { env: 'QQ_SECRET' }
    },
    [{ chatId: 'user', senderId: 'user' }],
    filename
  )

  using database = new DatabaseSync(filename)
  database.exec(
    "CREATE TRIGGER fail_selected BEFORE INSERT ON inbound WHEN NEW.event LIKE '%failed-write%' BEGIN SELECT RAISE(FAIL, 'injected write failure'); END"
  )
  await host.start()
  await expect
    .poll(() => remote.frames, { timeout: 2500 })
    .toContainEqual({ op: 1, d: 1 })
  const socket = remote.sockets[0]
  if (!socket) {
    throw new Error('Peer not connected')
  }
  socket.send(frame(2, 'C2C_MESSAGE_CREATE', createEvent('failed-write')))
  socket.send(frame(3, 'C2C_MESSAGE_CREATE', createEvent('next-message')))
  await expect.poll(() => socket.readyState).toBe(3)
  database.exec('DROP TRIGGER fail_selected')
  await expect
    .poll(() => remote.frames, { timeout: 4000 })
    .toContainEqual({
      op: 6,
      d: { token: 'QQBot token', session_id: 'session', seq: 1 }
    })
  await expect.poll(async () => (await records(host.storage)).length).toBe(2)
  expect(
    (await records(host.storage))
      .map((record) => record.snapshot.target.replyToId ?? '')
      .toSorted()
  ).toEqual(['failed-write', 'next-message'])
})

test('QQ authentication still times out when an unready gateway acknowledges heartbeats', async () => {
  vi.stubEnv('QQ_SECRET', 'secret')
  let address = ''

  const remote = await peer(
    (request) =>
      request.path === '/app/getAppAccessToken'
        ? { body: { access_token: 'token', expires_in: 7200 } }
        : { body: { url: address } },
    (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }))
      socket.on('message', (data) => {
        const received = z
          .object({ op: z.number() })
          .parse(JSON.parse(wireText(data)))

        if (received.op === 1) {
          socket.send(JSON.stringify({ op: 11 }))
        }
      })
    }
  )

  address = remote.ws

  const host = await assemble(
    createQqChannel(),
    {
      appId: 'app',
      clientSecret: { env: 'QQ_SECRET' }
    },
    [{ chatId: 'user', senderId: 'user' }]
  )

  await host.start()
  await expect.poll(() => remote.sockets.length, { timeout: 13_000 }).toBe(2)
  expect(await records(host.storage)).toHaveLength(0)
}, 15_000)

test.each([
  ['production', 'https://api.sgroup.qq.com'],
  ['sandbox', 'https://sandbox.api.sgroup.qq.com']
] as const)(
  'QQ %s selects the native API while keeping token acquisition on the fixed token host',
  async (environment, apiOrigin) => {
    vi.stubEnv('QQ_ENV_SECRET', 'secret')

    const remote = await peer((request) =>
      request.path === '/app/getAppAccessToken'
        ? { body: { access_token: 'token', expires_in: 7200 } }
        : { body: { id: 'sent' } }
    )

    const plugin = createQqChannel()
    await assemble(
      plugin,
      { appId: 'app', clientSecret: { env: 'QQ_ENV_SECRET' }, environment },
      [{ chatId: 'user', senderId: 'user' }]
    )
    expect(
      await plugin.send(
        sendInput('qq', 'user', {
          type: 'c2c',
          msgId: 'incoming',
          messageAt: Date.now(),
          scope: { appId: 'app', apiBase: `${apiOrigin}/` }
        })
      )
    ).toMatchObject({ status: 'sent' })
    expect(outboundRequests).toEqual([
      'https://bots.qq.com/app/getAppAccessToken',
      `${apiOrigin}/v2/users/user/messages`
    ])
    expect(remote.requests.map((request) => request.path)).toEqual([
      '/app/getAppAccessToken',
      '/v2/users/user/messages'
    ])
  }
)
