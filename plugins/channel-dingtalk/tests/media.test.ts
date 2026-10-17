import { peer } from './peer.js'
import { installPeerNetwork } from './network.js'
import { expect, test, vi } from 'vitest'
import type { SendInput } from '@relanox/sdk'
import { createDingTalkChannel } from '../src/index.js'
import { assemble, records } from '../../channel-wecom/tests/test-support.js'

installPeerNetwork()

test('DingTalk rejects denied pictures before OAuth or download and durably relays allowed pictures', async () => {
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
  // Native identity/content: open-dingtalk/dingtalk-stream-sdk-python
  // @8d8bb1c630848fee1ae8c7bdd11bc1b78097b611 dingtalk_stream/chatbot.py
  // ChatbotMessage.from_dict distinguishes senderId from senderStaffId and
  // ImageContent.from_dict reads content.downloadCode.
  remote.sockets[0]?.send(
    JSON.stringify({
      type: 'CALLBACK',
      headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'denied' },
      data: JSON.stringify({
        msgId: 'denied-picture',
        conversationType: '1',
        conversationId: 'single',
        senderId: 'denied-sender',
        senderStaffId: 'staff',
        robotCode: 'robot',
        msgtype: 'picture',
        content: { downloadCode: 'denied-code' }
      })
    })
  )
  await expect
    .poll(() => remote.frames)
    .toContainEqual({
      code: 200,
      headers: { contentType: 'application/json', messageId: 'denied' },
      message: 'OK',
      data: '{"response":null}'
    })
  expect(remote.requests.map((request) => request.path)).toEqual([
    '/v1.0/gateway/connections/open'
  ])
  expect(await records(local.storage)).toHaveLength(0)
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

test('DingTalk sends uploaded images between Markdown fragments and rejects mismatched rich media before upload', async () => {
  vi.stubEnv('DING_RICH_SECRET', 'secret')
  const bytes = new Uint8Array([1, 2, 3, 4, 5])

  const image = {
    reference: {
      id: 'image',
      kind: 'image' as const,
      mimeType: 'image/png',
      fileName: 'image.png',
      size: 5,
      sha256: '0'.repeat(64)
    },
    data: bytes
  }

  const remote = await peer((request) => {
    if (request.path === '/v1.0/oauth2/accessToken') {
      return { body: { accessToken: 'rich-token', expireIn: 7200 } }
    }
    if (request.path.startsWith('/media/upload?')) {
      return { body: { errcode: 0, media_id: '@native_image==' } }
    }
    return { body: { processQueryKey: 'rich-sent' } }
  })

  const plugin = createDingTalkChannel()
  await assemble(
    plugin,
    {
      clientId: 'app',
      robotCode: 'robot',
      clientSecret: { env: 'DING_RICH_SECRET' },
      recipientTypes: { staff: 'single' }
    },
    [{ chatId: 'staff', senderId: 'sender' }]
  )

  const resolved = await plugin.resolveChannel?.({
    platform: 'dingtalk',
    accountId: 'bot',
    chatId: 'staff',
    id: 'channel'
  })

  if (resolved?.status !== 'available') {
    throw new Error('missing_target')
  }

  const input: SendInput = {
    deliveryId: 'rich',
    channelId: 'channel',
    target: resolved.target,
    chunkIndex: 0,
    signal: new AbortController().signal,
    chunk: {
      text: '',
      state: null,
      idempotencyKey: 'rich',
      richText: [
        { type: 'text', text: '**before**' },
        { type: 'image', media: image.reference, label: 'photo' },
        { type: 'text', text: 'after' }
      ]
    },
    richMedia: [image]
  }

  expect(await plugin.send(input)).toMatchObject({ status: 'sent' })

  const upload = remote.requests.find((request) =>
    request.path.startsWith('/media/upload?')
  )

  expect(upload?.path).toContain('access_token=rich-token')
  expect(Buffer.isBuffer(upload?.body) && upload.body.includes(bytes)).toBe(
    true
  )

  const richHeaders: unknown = expect.objectContaining({
    'x-acs-dingtalk-access-token': 'rich-token'
  })

  expect(remote.requests).toContainEqual(
    expect.objectContaining({
      path: '/v1.0/robot/oToMessages/batchSend',
      headers: richHeaders,
      body: {
        robotCode: 'robot',
        userIds: ['staff'],
        msgKey: 'sampleMarkdown',
        msgParam:
          '{"title":"Relanox","text":"**before**\\n\\n![photo](@native_image==)\\n\\nafter"}'
      }
    })
  )
  const count = remote.requests.length
  expect(await plugin.send({ ...input, richMedia: [] })).toEqual({
    status: 'rejected',
    errorCode: 'invalid_rich_media'
  })
  expect(remote.requests).toHaveLength(count)
})

// Protect platform validation and refusals on ordinary and rich uploads. Old
// Byte, MIME and extension prechecks fail before HTTP; small supported files
// Cannot catch those paths. The existing plugin API needs no production seam.
// Legacy multipart contract: open.dingtalk.com/document/orgapp/upload-media-files;
// HTTP 413: RFC 9110 section 15.5.14.
test.each([
  {
    label: 'file above the former byte limit',
    kind: 'file' as const,
    mimeType: 'application/pdf',
    fileName: 'document.pdf',
    size: 21 * 1024 * 1024,
    rich: false
  },
  {
    label: 'rich image above the former byte limit',
    kind: 'image' as const,
    mimeType: 'image/png',
    fileName: 'picture.png',
    size: 21 * 1024 * 1024,
    rich: true
  },
  {
    label: 'image outside the former MIME allowlist',
    kind: 'image' as const,
    mimeType: 'image/svg+xml',
    fileName: 'picture.svg',
    size: 4,
    rich: false
  },
  {
    label: 'file outside the former extension allowlist',
    kind: 'file' as const,
    mimeType: 'application/octet-stream',
    fileName: 'document.bin',
    size: 4,
    rich: false
  }
])('DingTalk submits $label and preserves the upload refusal', async (item) => {
  vi.stubEnv('DING_UPLOAD_SECRET', 'secret')
  const bytes = new Uint8Array(item.size)

  const media = {
    reference: {
      id: 'document',
      kind: item.kind,
      mimeType: item.mimeType,
      fileName: item.fileName,
      size: bytes.byteLength,
      sha256: '0'.repeat(64)
    },
    data: bytes
  }

  const remote = await peer((request) =>
    request.path === '/v1.0/oauth2/accessToken'
      ? { body: { accessToken: 'upload-token', expireIn: 7200 } }
      : { status: 413 }
  )

  const plugin = createDingTalkChannel()
  await assemble(
    plugin,
    {
      clientId: 'app',
      robotCode: 'robot',
      clientSecret: { env: 'DING_UPLOAD_SECRET' },
      recipientTypes: { staff: 'single' }
    },
    [{ chatId: 'staff', senderId: 'sender' }]
  )

  const resolved = await plugin.resolveChannel?.({
    platform: 'dingtalk',
    accountId: 'bot',
    chatId: 'staff',
    id: 'channel'
  })

  if (resolved?.status !== 'available') {
    throw new Error('missing_target')
  }
  expect(
    await plugin.send({
      deliveryId: 'file',
      channelId: 'channel',
      target: resolved.target,
      chunkIndex: 0,
      signal: new AbortController().signal,
      chunk: {
        text: '',
        ...(item.rich
          ? {
              richText: [
                {
                  type: 'image' as const,
                  media: media.reference,
                  label: item.fileName
                }
              ]
            }
          : { media: media.reference }),
        state: null,
        idempotencyKey: 'file'
      },
      ...(item.rich ? { richMedia: [media] } : { media })
    })
  ).toEqual({ status: 'rejected', errorCode: 'http_413' })

  const uploads = remote.requests.filter((request) =>
    request.path.startsWith('/media/upload?')
  )

  expect(uploads).toHaveLength(1)
  expect(uploads[0]?.path).toContain(`type=${item.kind}`)
  expect(
    Buffer.isBuffer(uploads[0]?.body) ? uploads[0].body.byteLength : 0
  ).toBeGreaterThan(bytes.byteLength)
  expect(
    remote.requests.filter(
      (request) => request.path === '/v1.0/robot/oToMessages/batchSend'
    )
  ).toHaveLength(0)
})
