import { expect, test, vi } from 'vitest'
import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import {
  assemble,
  peer,
  records
} from '../../channel-wecom/tests/test-support.js'
import { createDingTalkChannel } from '../src/index.js'

installPeerNetwork()

// Native callback payload: open-dingtalk/dingtalk-stream-sdk-python
// @8d8bb1c630848fee1ae8c7bdd11bc1b78097b611 dingtalk_stream/chatbot.py.
const picture = {
  msgId: 'picture-message',
  conversationType: '1',
  conversationId: 'single',
  senderId: 'sender',
  senderStaffId: 'staff',
  robotCode: 'robot',
  msgtype: 'picture',
  content: { downloadCode: 'temporary-code', fileName: 'picture.png' }
}

function frame(messageId: string, message: unknown): string {
  return JSON.stringify({
    type: 'CALLBACK',
    headers: { topic: '/v1.0/im/bot/messages/get', messageId },
    data: JSON.stringify(message)
  })
}

function ping(messageId: string): string {
  return JSON.stringify({
    type: 'SYSTEM',
    headers: { topic: 'ping', messageId },
    data: '{}'
  })
}

function ack(
  messageId: string,
  data = '{"response":null}'
): {
  code: number
  headers: { contentType: string; messageId: string }
  message: string
  data: string
} {
  return {
    code: 200,
    headers: { contentType: 'application/json', messageId },
    message: 'OK',
    data
  }
}

test('DingTalk keeps delayed callback ACKs on their originating Stream session', async () => {
  vi.stubEnv('DING_SESSION_SECRET', 'secret')
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6])
  let websocket = ''
  let downloadUrl = ''
  let finishDownload: (() => void) | undefined

  const downloadReady = new Promise<void>((resolve) => {
    finishDownload = resolve
  })

  const remote = await peer(async (request) => {
    if (request.path === '/v1.0/gateway/connections/open') {
      return { body: { endpoint: websocket, ticket: 'ticket' } }
    }
    if (request.path === '/v1.0/oauth2/accessToken') {
      return { body: { accessToken: 'token', expireIn: 7200 } }
    }
    if (request.path === '/v1.0/robot/messageFiles/download') {
      return { body: { downloadUrl } }
    }
    await downloadReady
    return { body: bytes, headers: { 'content-type': 'image/png' } }
  })

  websocket = remote.ws
  downloadUrl = `${remote.http}/picture.png`
  const plugin = createDingTalkChannel()

  const local = await assemble(
    plugin,
    {
      clientId: 'app',
      clientSecret: { env: 'DING_SESSION_SECRET' },
      robotCode: 'robot'
    },
    [{ chatId: 'staff', senderId: 'sender' }]
  )

  await local.start()
  try {
    const first = remote.sockets[0]
    if (!first) {
      throw new Error('missing_initial_socket')
    }
    first.send(frame('old-session-callback', picture))
    await expect
      .poll(() => remote.requests.map((request) => request.path))
      .toContain('/picture.png')
    first.terminate()
    await expect.poll(() => remote.sockets.length, { timeout: 3000 }).toBe(2)
    const replacement = remote.sockets[1]
    if (!replacement) {
      throw new Error('missing_replacement_socket')
    }
    replacement.send(ping('replacement-ready'))
    await expect
      .poll(() => remote.frames)
      .toContainEqual(ack('replacement-ready', '{}'))
    finishDownload?.()
    await expect.poll(async () => (await records(local.storage)).length).toBe(1)
    replacement.send(ping('after-delayed-callback'))
    await expect
      .poll(() => remote.frames)
      .toContainEqual(ack('after-delayed-callback', '{}'))
    // Node SDK@e7fe301d9afdcc1d62d2b7ffeba6fe7768b6489c client.ts
    // Binds onCallback()/socketCallBackResponse() to the receiving socket.
    expect(remote.frames).not.toContainEqual(ack('old-session-callback'))
    replacement.send(frame('redelivery-on-replacement', picture))
    await expect
      .poll(() => remote.frames)
      .toContainEqual(ack('redelivery-on-replacement'))
    expect(await records(local.storage)).toHaveLength(1)
  } finally {
    finishDownload?.()
  }
})

test('DingTalk ACKs a known media size rejection and keeps accepting text on the same session', async () => {
  vi.stubEnv('DING_SIZE_SECRET', 'secret')
  let websocket = ''
  let downloadUrl = ''

  const remote = await peer((request) => {
    if (request.path === '/v1.0/gateway/connections/open') {
      return { body: { endpoint: websocket, ticket: 'ticket' } }
    }
    if (request.path === '/v1.0/oauth2/accessToken') {
      return { body: { accessToken: 'token', expireIn: 7200 } }
    }
    if (request.path === '/v1.0/robot/messageFiles/download') {
      return { body: { downloadUrl } }
    }
    return {
      body: Buffer.alloc(1),
      headers: { 'content-type': 'image/png', 'content-length': '26214401' }
    }
  })

  websocket = remote.ws
  downloadUrl = `${remote.http}/picture.png`
  const plugin = createDingTalkChannel()

  const local = await assemble(
    plugin,
    {
      clientId: 'app',
      clientSecret: { env: 'DING_SIZE_SECRET' },
      robotCode: 'robot'
    },
    [{ chatId: 'staff', senderId: 'sender' }]
  )

  await local.start()
  const socket = remote.sockets[0]
  if (!socket) {
    throw new Error('missing_initial_socket')
  }
  socket.send(frame('oversized-picture', picture))
  await expect
    .poll(() => remote.frames)
    .toContainEqual(ack('oversized-picture'))
  socket.send(
    frame('text-after-rejection', {
      ...picture,
      msgId: 'text-message',
      msgtype: 'text',
      text: { content: 'question after oversized picture' }
    })
  )
  await expect
    .poll(() => remote.frames)
    .toContainEqual(ack('text-after-rejection'))
  const saved = await records(local.storage)
  expect(saved).toHaveLength(1)
  expect(saved[0]?.snapshot.text).toBe('question after oversized picture')
  expect(remote.sockets).toHaveLength(1)
})

test('DingTalk leaves failed media downloads unacknowledged until redelivery saves the message', async () => {
  vi.stubEnv('DING_RETRY_SECRET', 'secret')
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6])
  let websocket = ''
  let downloadUrl = ''
  let available = false

  const remote = await peer((request) => {
    if (request.path === '/v1.0/gateway/connections/open') {
      return { body: { endpoint: websocket, ticket: 'ticket' } }
    }
    if (request.path === '/v1.0/oauth2/accessToken') {
      return { body: { accessToken: 'token', expireIn: 7200 } }
    }
    if (request.path === '/v1.0/robot/messageFiles/download') {
      return { body: { downloadUrl } }
    }
    return available
      ? { body: bytes, headers: { 'content-type': 'image/png' } }
      : { status: 503 }
  })

  websocket = remote.ws
  downloadUrl = `${remote.http}/picture.png`
  const plugin = createDingTalkChannel()

  const local = await assemble(
    plugin,
    {
      clientId: 'app',
      clientSecret: { env: 'DING_RETRY_SECRET' },
      robotCode: 'robot'
    },
    [{ chatId: 'staff', senderId: 'sender' }]
  )

  await local.start()
  const first = remote.sockets[0]
  if (!first) {
    throw new Error('missing_initial_socket')
  }
  first.send(frame('failed-download', picture))
  await expect.poll(() => first.readyState).toBe(3)
  expect(remote.frames).toEqual([])
  expect(await records(local.storage)).toHaveLength(0)
  available = true
  await expect.poll(() => remote.sockets.length, { timeout: 3000 }).toBe(2)
  remote.sockets[1]?.send(frame('recovered-download', picture))
  await expect
    .poll(() => remote.frames)
    .toContainEqual(ack('recovered-download'))
  expect(await records(local.storage)).toHaveLength(1)
})
