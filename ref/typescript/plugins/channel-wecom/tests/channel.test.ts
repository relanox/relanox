import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import { wireText } from '../../channel-wecom/src/transport.js'
import { z } from 'zod'
import { createWeComChannel } from '../src/index.js'
import {
  assemble,
  peer,
  records,
  sendInput,
  startConnected
} from './test-support.js'

installPeerNetwork()

test('WeCom uses the selected callback request for out-of-order native replies and independent sends otherwise', async () => {
  // Official SDK reply/replyStream preserve frame.headers.req_id and use a
  // Completed stream envelope for text. sendMessage creates an independent ID.
  // https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/client.ts
  vi.stubEnv('WECOM_REPLY_SECRET', 'secret')

  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on('message', (raw) => {
        const frame = z
          .object({ headers: z.object({ req_id: z.string() }) })
          .parse(JSON.parse(wireText(raw)))

        socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
      })
    }
  )

  const host = await assemble(
    createWeComChannel(),
    { botId: 'robot', secret: { env: 'WECOM_REPLY_SECRET' } },
    [{ chatId: 'user', senderId: 'user' }]
  )

  await startConnected(host)
  for (const number of [1, 2, 3]) {
    remote.sockets[0]?.send(
      JSON.stringify({
        cmd: 'aibot_msg_callback',
        headers: { req_id: `native-callback-${number}` },
        body: {
          msgid: `message-${number}`,
          aibotid: 'robot',
          chattype: 'single',
          from: { userid: 'user' },
          msgtype: 'text',
          text: { content: `question ${number}` }
        }
      })
    )
  }
  await expect.poll(async () => (await records(host.storage)).length).toBe(3)
  const accepted = await records(host.storage)
  const principal = host.principal()
  const channel = accepted[0]?.snapshot.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }
  for (const number of [2, 1, 3]) {
    const selected = accepted.find(
      (item) => item.snapshot.source.eventId === `message-${number}`
    )

    if (!selected) {
      throw new Error('missing_request')
    }
    expect(
      await principal.sendMessage({
        channel,
        text: `answer ${number}`,
        idempotencyKey: `reply-${number}`,
        reply: { requestId: selected.snapshot.requestId, kind: 'final' }
      })
    ).toMatchObject({ status: 'queued' })
    await host.runtime.processDue()
  }
  expect(
    await principal.sendMessage({
      channel,
      text: 'ordinary',
      idempotencyKey: 'ordinary'
    })
  ).toMatchObject({ status: 'queued' })
  await host.runtime.processDue()
  expect(remote.frames.slice(1, 4)).toMatchObject([
    {
      cmd: 'aibot_respond_msg',
      headers: { req_id: 'native-callback-2' },
      body: { msgtype: 'stream', stream: { finish: true, content: 'answer 2' } }
    },
    {
      cmd: 'aibot_respond_msg',
      headers: { req_id: 'native-callback-1' },
      body: { msgtype: 'stream', stream: { finish: true, content: 'answer 1' } }
    },
    {
      cmd: 'aibot_respond_msg',
      headers: { req_id: 'native-callback-3' },
      body: { msgtype: 'stream', stream: { finish: true, content: 'answer 3' } }
    }
  ])
  expect(remote.frames).toHaveLength(5)
  expect(remote.frames[4]).toMatchObject({
    cmd: 'aibot_send_msg',
    body: {
      chatid: 'user',
      msgtype: 'markdown',
      markdown: { content: 'ordinary' }
    }
  })
})

test('WeCom discards learned response context when recipient type changes', async () => {
  vi.stubEnv('WECOM_REPLY_SECRET', 'secret')
  const plugin = createWeComChannel()
  await assemble(
    plugin,
    {
      botId: 'robot',
      secret: { env: 'WECOM_REPLY_SECRET' },
      recipientTypes: { user: 'group' }
    },
    [{ chatId: 'user', senderId: 'user' }]
  )

  const resolved = await plugin.resolveChannel?.(
    { id: 'channel', platform: 'wecom', accountId: 'bot', chatId: 'user' },
    {
      channel: 'wecom',
      accountId: 'bot',
      chatId: 'user',
      replyToId: 'message',
      data: {
        chattype: 'single',
        callbackReqId: 'original-request',
        scope: { botId: 'robot', wsUrl: 'wss://openws.work.weixin.qq.com/' }
      }
    }
  )

  expect(resolved).toEqual({
    status: 'available',
    target: {
      channel: 'wecom',
      accountId: 'bot',
      chatId: 'user',
      data: {
        chattype: 'group',
        scope: { botId: 'robot', wsUrl: 'wss://openws.work.weixin.qq.com/' }
      }
    }
  })
})

test('WeCom subscribes, deduplicates body IDs, keeps durable targets and sends independent escaped Markdown', async () => {
  vi.stubEnv('WECOM_SECRET', 'private-value')

  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on('message', (data) => {
        const frame = z
          .object({
            cmd: z.string(),
            headers: z.object({ req_id: z.string() })
          })
          .parse(JSON.parse(wireText(data)))

        socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
      })
    }
  )

  const plugin = createWeComChannel()

  const host = await assemble(
    plugin,
    {
      botId: 'robot',
      secret: { env: 'WECOM_SECRET' }
    },
    [
      { chatId: 'user', senderId: 'user' },
      { chatId: 'group', senderId: 'user' }
    ]
  )

  await startConnected(host)
  expect(remote.frames[0]).toMatchObject({
    cmd: 'aibot_subscribe',
    body: { bot_id: 'robot', secret: 'private-value' }
  })
  const socket = remote.sockets[0]
  if (!socket) {
    throw new Error('Peer not connected')
  }

  const body = {
    msgid: 'stable-1',
    aibotid: 'robot',
    chattype: 'single',
    from: { userid: 'user' },
    msgtype: 'text',
    text: { content: 'question' },
    response_url: 'https://secret.invalid/token'
  }

  socket.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback-1' },
      body
    })
  )
  socket.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback-2' },
      body
    })
  )
  socket.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback-3' },
      body: {
        ...body,
        msgid: 'stable-group',
        chattype: 'group',
        chatid: 'group'
      }
    })
  )
  socket.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'wrong-bot' },
      body: { ...body, aibotid: 'other', msgid: 'wrong' }
    })
  )
  socket.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'media' },
      body: { ...body, msgid: 'media', msgtype: 'image' }
    })
  )
  await expect.poll(async () => (await records(host.storage)).length).toBe(2)
  const accepted = await records(host.storage)
  expect(
    accepted.map((item) => item.snapshot.source.eventId).toSorted()
  ).toEqual(['stable-1', 'stable-group'])
  expect(
    accepted.map((item) => item.snapshot.target.chatId).toSorted()
  ).toEqual(['group', 'user'])
  expect(JSON.stringify(accepted)).not.toContain('secret.invalid')

  const result = await plugin.send(
    sendInput('wecom', 'group', {
      chattype: 'group',
      scope: { botId: 'robot', wsUrl: 'wss://openws.work.weixin.qq.com/' }
    })
  )

  expect(result).toEqual({ status: 'sent', receipt: {} })
  expect(remote.frames.at(-1)).toMatchObject({
    cmd: 'aibot_send_msg',
    body: {
      chatid: 'group',
      msgtype: 'markdown',
      markdown: { content: 'hello_*世界' }
    }
  })
})

test('WeCom correlates heartbeats and preserves uncertain sends when the socket closes before ACK', async () => {
  vi.stubEnv('WECOM_SECRET', 'secret')

  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on('message', (data) => {
        const frame = z
          .object({
            cmd: z.string(),
            headers: z.object({ req_id: z.string() })
          })
          .parse(JSON.parse(wireText(data)))

        if (frame.cmd === 'aibot_send_msg') {
          socket.send(
            JSON.stringify({ headers: { req_id: 'unrelated' }, errcode: 0 })
          )
          socket.close()
        } else {
          socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
        }
      })
    }
  )

  const plugin = createWeComChannel()

  const host = await assemble(
    plugin,
    {
      botId: 'robot',
      secret: { env: 'WECOM_SECRET' }
    },
    [{ chatId: 'user', senderId: 'user' }]
  )

  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    await host.start()
    await expect
      .poll(
        async () => (await host.runtime.status()).connections['channels/bot']
      )
      .toBe('connected')
    await vi.advanceTimersByTimeAsync(30_000)
  } finally {
    vi.useRealTimers()
  }
  await expect
    .poll(
      () =>
        remote.frames.some(
          (frame) =>
            z.object({ cmd: z.literal('ping') }).safeParse(frame).success
        ),
      { timeout: 3000 }
    )
    .toBe(true)
  expect(
    await plugin.send(
      sendInput('wecom', 'user', {
        chattype: 'single',
        scope: { botId: 'robot', wsUrl: 'wss://openws.work.weixin.qq.com/' }
      })
    )
  ).toEqual({
    status: 'unknown',
    errorCode: 'transport_uncertain'
  })
  host.controller.abort()
  await new Promise((resolve) => {
    setTimeout(resolve, 1200)
  })
  expect(remote.sockets).toHaveLength(1)
  expect(plugin.capabilities.idempotentSend).toBe(false)
})

test('WeCom rejects raw secrets and insecure nonlocal endpoints', () => {
  const plugin = createWeComChannel()
  expect(() =>
    plugin.validateConfig({ botId: 'robot', secret: 'raw' })
  ).toThrow()
  expect(() =>
    plugin.validateConfig({
      botId: 'robot',
      secret: { env: 'SECRET' },
      wsUrl: 'ws://remote.example'
    })
  ).toThrow()
})

test('WeCom stops recovery after the platform replaces this bot connection', async () => {
  vi.stubEnv('WECOM_SECRET', 'secret')

  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on('message', (data) => {
        const frame = z
          .object({ headers: z.object({ req_id: z.string() }) })
          .parse(JSON.parse(wireText(data)))

        socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
      })
    }
  )

  const plugin = createWeComChannel()

  const host = await assemble(
    plugin,
    {
      botId: 'robot',
      secret: { env: 'WECOM_SECRET' }
    },
    [{ chatId: 'user', senderId: 'user' }]
  )

  await startConnected(host)
  const socket = remote.sockets[0]
  if (!socket) {
    throw new Error('Peer not connected')
  }
  socket.send(
    JSON.stringify({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'replaced' },
      body: {
        aibotid: 'robot',
        msgid: 'replaced-message',
        msgtype: 'event',
        create_time: Date.now(),
        from: { userid: 'robot' },
        event: { eventtype: 'disconnected_event' }
      }
    })
  )
  await expect
    .poll(async () => (await host.runtime.status()).connections['channels/bot'])
    .toBe('degraded')
  await new Promise((resolve) => {
    setTimeout(resolve, 1200)
  })
  expect(remote.sockets).toHaveLength(1)
  expect(
    await plugin.send(
      sendInput('wecom', 'user', {
        chattype: 'single',
        scope: { botId: 'robot', wsUrl: 'wss://openws.work.weixin.qq.com/' }
      })
    )
  ).toMatchObject({
    status: 'retryable',
    errorCode: 'not_connected'
  })
})

test.each(['missing credential', 'rejected subscription'])(
  'WeCom closes an unauthenticated socket after %s',
  async (scenario) => {
    vi.stubEnv(
      'WECOM_SECRET',
      scenario === 'missing credential' ? '' : 'secret'
    )

    const remote = await peer(
      () => ({ status: 404 }),
      (socket) => {
        socket.on('message', (data) => {
          const frame = z
            .object({ headers: z.object({ req_id: z.string() }) })
            .parse(JSON.parse(wireText(data)))

          socket.send(
            JSON.stringify({ headers: frame.headers, errcode: 40_001 })
          )
        })
      }
    )

    const plugin = createWeComChannel()

    const host = await assemble(
      plugin,
      {
        botId: 'robot',
        secret: { env: 'WECOM_SECRET' }
      },
      [{ chatId: 'user', senderId: 'user' }]
    )

    await host.start()
    if (scenario === 'missing credential') {
      expect(remote.sockets).toEqual([])
    } else {
      await expect.poll(() => remote.sockets[0]?.readyState).toBe(3)
    }
    expect(
      await plugin.send(
        sendInput('wecom', 'user', {
          chattype: 'single',
          scope: { botId: 'robot', wsUrl: 'wss://openws.work.weixin.qq.com/' }
        })
      )
    ).toMatchObject({
      status: 'retryable',
      errorCode: 'not_connected'
    })
    expect(await records(host.storage)).toHaveLength(0)
  }
)

test('WeCom websocket sends to explicitly configured single/group conversations before any inbound message', async () => {
  vi.stubEnv('WECOM_SECRET', 'secret')

  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on('message', (bytes) => {
        const frame = z
          .object({ headers: z.object({ req_id: z.string() }) })
          .parse(JSON.parse(wireText(bytes)))

        socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
      })
    }
  )

  const plugin = createWeComChannel()

  const host = await assemble(
    plugin,
    {
      botId: 'robot',
      secret: { env: 'WECOM_SECRET' },
      recipientTypes: { user: 'single', group: 'group' }
    },
    [
      { chatId: 'user', senderId: 'user' },
      { chatId: 'group', senderId: 'user' }
    ]
  )

  await startConnected(host)
  for (const chatId of ['user', 'group']) {
    const resolved = await plugin.resolveChannel?.({
      id: 'channel',
      platform: 'wecom',
      accountId: 'bot',
      chatId
    })

    if (resolved?.status !== 'available') {
      throw new Error('missing_destination')
    }
    expect(resolved.target.replyToId).toBeUndefined()
    expect(
      await plugin.send({
        ...sendInput(
          'wecom',
          chatId,
          resolved.target.data,
          `proactive:${chatId}`
        ),
        target: resolved.target
      })
    ).toMatchObject({ status: 'sent' })
    expect(remote.frames.at(-1)).toMatchObject({
      cmd: 'aibot_send_msg',
      body: { chatid: chatId }
    })
  }
  expect(await records(host.storage)).toEqual([])
})
