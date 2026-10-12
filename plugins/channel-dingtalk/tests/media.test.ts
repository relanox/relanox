import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import { createDingTalkChannel } from '../src/index.js'
import {
  assemble,
  peer,
  records
} from '../../channel-wecom/tests/test-support.js'

installPeerNetwork()

test('DingTalk downloads a pure picture before durable ACK and uploads original multipart bytes', async () => {
  vi.stubEnv('DING_MEDIA_SECRET', 'secret')
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6])
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
    if (request.path === '/picture.png') {
      return { body: bytes, headers: { 'content-type': 'image/png' } }
    }
    if (request.path.startsWith('/media/upload?')) {
      return { body: { errcode: 0, media_id: 'native-image' } }
    }
    return { body: { processQueryKey: 'sent' } }
  })

  websocket = remote.ws
  downloadUrl = `${remote.http}/picture.png`
  const plugin = createDingTalkChannel()

  const local = await assemble(
    plugin,
    {
      clientId: 'app',
      clientSecret: { env: 'DING_MEDIA_SECRET' },
      robotCode: 'robot'
    },
    [{ chatId: 'staff', senderId: 'sender' }]
  )

  await local.start()
  remote.sockets[0]?.send(
    JSON.stringify({
      type: 'CALLBACK',
      headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'callback' },
      data: JSON.stringify({
        msgId: 'picture-message',
        conversationType: '1',
        conversationId: 'single',
        senderId: 'sender',
        senderStaffId: 'staff',
        robotCode: 'robot',
        msgtype: 'picture',
        content: { downloadCode: 'temporary-code', fileName: 'picture.png' }
      })
    })
  )
  await expect.poll(async () => (await records(local.storage)).length).toBe(1)
  await expect
    .poll(() => remote.frames, { timeout: 5000 })
    .toContainEqual(
      expect.objectContaining({
        code: 200,
        headers: { contentType: 'application/json', messageId: 'callback' }
      })
    )
  const scoped = local.principal()
  const task = (await local.storage.listInbound({ limit: 10 }))[0]?.snapshot
  if (!task?.attachments?.[0]) {
    throw new Error('missing_durable_media')
  }
  expect(task.text).toBe('')
  await scoped.sendMessage({
    channel: task.channel.id,
    idempotencyKey: 'result',
    text: '**caption** [link](https://example.com)',
    attachments: [task.attachments[0].id]
  })
  await local.runtime.processDue()

  const upload = remote.requests.find((request) =>
    request.path.startsWith('/media/upload?')
  )

  expect(upload?.headers['content-type']).toMatch(
    /^multipart\/form-data; boundary=/u
  )
  expect(upload?.path).toContain('type=image')
  expect(Buffer.isBuffer(upload?.body) && upload.body.includes(bytes)).toBe(
    true
  )
  expect(remote.requests).toContainEqual(
    expect.objectContaining({
      path: '/v1.0/robot/oToMessages/batchSend',
      body: {
        robotCode: 'robot',
        userIds: ['staff'],
        msgKey: 'sampleImageMsg',
        msgParam: '{"photoURL":"native-image"}'
      }
    })
  )
  expect(remote.requests).toContainEqual(
    expect.objectContaining({
      path: '/v1.0/robot/oToMessages/batchSend',
      body: {
        robotCode: 'robot',
        userIds: ['staff'],
        msgKey: 'sampleMarkdown',
        msgParam:
          '{"title":"Relanox","text":"**caption** [link](https://example.com)"}'
      }
    })
  )
})
