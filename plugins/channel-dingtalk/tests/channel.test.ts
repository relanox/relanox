import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import {
  assemble,
  peer,
  records,
  sendInput
} from '../../channel-wecom/tests/test-support.js'
import { createDingTalkChannel } from '../src/index.js'

installPeerNetwork()

const message = {
  msgId: 'stable-message',
  conversationType: '1',
  conversationId: 'single-conversation',
  senderId: 'platform-sender',
  senderStaffId: 'staff',
  chatbotUserId: 'bot-user',
  robotCode: 'robot-code',
  msgtype: 'text',
  text: { content: 'question' },
  sessionWebhook: 'https://secret.invalid/short-token',
  sessionWebhookExpiredTime: 1
}

const robotFrame = (
  messageId: string,
  body: unknown
): {
  specVersion: string
  type: string
  headers: { topic: string; messageId: string; contentType: string }
  data: string
} => ({
  specVersion: '1.0',
  type: 'CALLBACK',
  headers: {
    topic: '/v1.0/im/bot/messages/get',
    messageId,
    contentType: 'application/json'
  },
  data: JSON.stringify(body)
})

test('DingTalk acknowledges the native disconnect frame before closing the Stream socket', async () => {
  vi.stubEnv('DING_SECRET', 'secret')
  let address = ''

  const remote = await peer(() => ({
    body: { endpoint: address, ticket: 'ticket' }
  }))

  address = remote.ws
  const plugin = createDingTalkChannel()

  const host = await assemble(
    plugin,
    {
      clientId: 'app',
      clientSecret: { env: 'DING_SECRET' },
      robotCode: 'robot-code'
    },
    [{ chatId: 'staff', senderId: 'platform-sender' }]
  )

  await host.start()
  const socket = remote.sockets[0]
  if (!socket) {
    throw new Error('Peer not connected')
  }
  // Official SDK: open-dingtalk/dingtalk-stream-sdk-nodejs@e7fe301d9afdcc1d62d2b7ffeba6fe7768b6489c
  // Src/client.ts onSystem('disconnect') echoes the payload with code 200 before close.
  socket.send(
    JSON.stringify({
      type: 'SYSTEM',
      headers: { topic: 'disconnect', messageId: 'disconnect-request' },
      data: '{"reason":"server rotation"}'
    })
  )
  await expect.poll(() => socket.readyState).toBe(3)
  expect(remote.frames).toContainEqual({
    code: 200,
    headers: {
      contentType: 'application/json',
      messageId: 'disconnect-request'
    },
    message: 'OK',
    data: '{"reason":"server rotation"}'
  })
  host.controller.abort()
})

test('DingTalk authenticates Stream, ACKs durable stable messages and sends to staff/group via OpenAPI', async () => {
  vi.stubEnv('DING_SECRET', 'first-secret')
  let address = ''

  const remote = await peer((request) => {
    if (request.path === '/v1.0/gateway/connections/open') {
      return { body: { endpoint: address, ticket: 'once-ticket' } }
    }
    if (request.path === '/v1.0/oauth2/accessToken') {
      return { body: { accessToken: 'cloud-token', expireIn: 7200 } }
    }
    return {
      body: {
        processQueryKey: 'query-handle',
        invalidStaffIdList: [],
        flowControlledStaffIdList: []
      }
    }
  })

  address = remote.ws
  const plugin = createDingTalkChannel()

  const host = await assemble(
    plugin,
    {
      clientId: 'app',
      clientSecret: { env: 'DING_SECRET' },
      robotCode: 'robot-code'
    },
    [
      { chatId: 'staff', senderId: 'platform-sender' },
      { chatId: 'group-conversation', senderId: 'platform-sender' }
    ]
  )

  await host.start()
  expect(remote.requests[0]?.body).toEqual({
    clientId: 'app',
    clientSecret: 'first-secret',
    ua: 'relanox-node/0.1.0',
    subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }]
  })
  const socket = remote.sockets[0]
  if (!socket) {
    throw new Error('Peer not connected')
  }
  socket.send(JSON.stringify(robotFrame('delivery-one', message)))
  socket.send(JSON.stringify(robotFrame('delivery-redelivered', message)))
  socket.send(
    JSON.stringify(
      robotFrame('delivery-group', {
        ...message,
        msgId: 'group-message',
        conversationType: '2',
        conversationId: 'group-conversation',
        isInAtList: true
      })
    )
  )
  socket.send(
    JSON.stringify({
      type: 'SYSTEM',
      headers: { topic: 'ping', messageId: 'system-ping' },
      data: '{"opaque":"ping-value"}'
    })
  )
  await expect.poll(() => remote.frames.length).toBe(4)
  expect(await records(host.storage)).toHaveLength(2)
  expect(
    (await records(host.storage))
      .map((record) => record.snapshot.source.eventId)
      .toSorted()
  ).toEqual(['group-message', 'stable-message'])
  expect((await records(host.storage))[0]?.snapshot.senderId).toBe(
    'platform-sender'
  )
  expect(JSON.stringify(await records(host.storage))).not.toContain(
    'short-token'
  )
  expect(remote.frames).toContainEqual({
    code: 200,
    headers: { contentType: 'application/json', messageId: 'delivery-one' },
    message: 'OK',
    data: '{"response":null}'
  })
  expect(remote.frames).toContainEqual({
    code: 200,
    headers: { contentType: 'application/json', messageId: 'system-ping' },
    message: 'OK',
    data: '{"opaque":"ping-value"}'
  })
  expect(
    await plugin.send(
      sendInput('dingtalk', 'staff', {
        type: 'single',
        staffId: 'staff',
        scope: {
          clientId: 'app',
          robotCode: 'robot-code',
          apiBase: 'https://api.dingtalk.com/'
        }
      })
    )
  ).toEqual({
    status: 'sent',
    receipt: { data: { processQueryKey: 'query-handle' } }
  })
  vi.stubEnv('DING_SECRET', 'rotated-secret')
  expect(
    (
      await plugin.send(
        sendInput(
          'dingtalk',
          'group-conversation',
          {
            type: 'group',
            openConversationId: 'group-conversation',
            scope: {
              clientId: 'app',
              robotCode: 'robot-code',
              apiBase: 'https://api.dingtalk.com/'
            }
          },
          'delivery:1'
        )
      )
    ).status
  ).toBe('sent')
  expect(
    remote.requests
      .filter((request) => request.path === '/v1.0/oauth2/accessToken')
      .map((request) => request.body)
  ).toEqual([
    { appKey: 'app', appSecret: 'first-secret' },
    { appKey: 'app', appSecret: 'rotated-secret' }
  ])

  const single = remote.requests.find(
    (request) => request.path === '/v1.0/robot/oToMessages/batchSend'
  )

  expect(single?.headers['x-acs-dingtalk-access-token']).toBe('cloud-token')
  expect(single?.body).toEqual({
    robotCode: 'robot-code',
    userIds: ['staff'],
    msgKey: 'sampleMarkdown',
    msgParam: '{"title":"Relanox","text":"hello_*世界"}'
  })
  expect(
    remote.requests.find(
      (request) => request.path === '/v1.0/robot/groupMessages/send'
    )?.body
  ).toEqual({
    robotCode: 'robot-code',
    openConversationId: 'group-conversation',
    msgKey: 'sampleMarkdown',
    msgParam: '{"title":"Relanox","text":"hello_*世界"}'
  })
})

test('DingTalk never acknowledges text after a failed durable write; unmentioned groups/media/bots create no task', async () => {
  vi.stubEnv('DING_SECRET', 'secret')
  let address = ''

  const remote = await peer(() => ({
    body: { endpoint: address, ticket: 'ticket' }
  }))

  address = remote.ws
  const plugin = createDingTalkChannel()

  const host = await assemble(
    plugin,
    {
      clientId: 'app',
      clientSecret: { env: 'DING_SECRET' },
      robotCode: 'robot-code'
    },
    [{ chatId: 'staff', senderId: 'platform-sender' }]
  )

  await host.start()
  const socket = remote.sockets[0]
  if (!socket) {
    throw new Error('Peer not connected')
  }
  socket.send(
    JSON.stringify(
      robotFrame('unmentioned', {
        ...message,
        conversationType: '2',
        isInAtList: false
      })
    )
  )
  socket.send(
    JSON.stringify(robotFrame('media', { ...message, msgtype: 'picture' }))
  )
  socket.send(
    JSON.stringify(robotFrame('bot-loop', { ...message, senderId: 'bot-user' }))
  )
  socket.send(
    JSON.stringify(
      robotFrame('denied', {
        ...message,
        senderId: 'stranger',
        msgId: 'denied-message'
      })
    )
  )
  await expect.poll(() => remote.frames.length).toBe(4)
  expect(await records(host.storage)).toHaveLength(0)
  expect(remote.frames).toContainEqual({
    code: 404,
    headers: { contentType: 'application/json', messageId: 'media' },
    message: 'Unsupported',
    data: '{"response":null}'
  })
  await host.storage.close()
  socket.send(JSON.stringify(robotFrame('must-not-ack', message)))
  await expect.poll(() => socket.readyState).toBe(3)
  expect(remote.frames).toHaveLength(4)
  host.controller.abort()
})

test.each([
  {
    reply: { status: 429, headers: { 'retry-after': '2' } },
    result: {
      status: 'retryable',
      errorCode: 'rate_limited',
      retryAfterMs: 2000
    }
  },
  {
    reply: {
      body: { processQueryKey: 'handle', flowControlledStaffIdList: ['staff'] }
    },
    result: {
      status: 'retryable',
      errorCode: 'staff_rate_limited',
      retryAfterMs: 1000
    }
  },
  {
    reply: {
      body: { processQueryKey: 'handle', invalidStaffIdList: ['staff'] }
    },
    result: { status: 'rejected', errorCode: 'invalid_staff_id' }
  },
  {
    reply: { status: 403 },
    result: { status: 'rejected', errorCode: 'http_403' }
  },
  {
    reply: { disconnect: true },
    result: { status: 'unknown', errorCode: 'transport_uncertain' }
  }
])(
  'DingTalk preserves the remote outcome $result.errorCode',
  async ({ reply, result }) => {
    vi.stubEnv('DING_SECRET', 'secret')

    await peer((request) =>
      request.path === '/v1.0/oauth2/accessToken'
        ? { body: { accessToken: 'token', expireIn: 7200 } }
        : reply
    )

    const plugin = createDingTalkChannel()
    await assemble(
      plugin,
      {
        clientId: 'app',
        clientSecret: { env: 'DING_SECRET' },
        robotCode: 'robot-code'
      },
      [{ chatId: 'staff', senderId: 'platform-sender' }]
    )
    expect(
      await plugin.send(
        sendInput('dingtalk', 'staff', {
          type: 'single',
          staffId: 'staff',
          scope: {
            clientId: 'app',
            robotCode: 'robot-code',
            apiBase: 'https://api.dingtalk.com/'
          }
        })
      )
    ).toEqual(result)
  }
)
