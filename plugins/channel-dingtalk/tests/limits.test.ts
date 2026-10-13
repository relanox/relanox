import { expect, test, vi } from 'vitest'
import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { peer, records } from '../../channel-wecom/tests/test-support.js'
import { limitsRuntime } from './limits-runtime.js'

installPeerNetwork()

// Native rich-text callback items: open-dingtalk/dingtalk-stream-sdk-python
// @8d8bb1c630848fee1ae8c7bdd11bc1b78097b611 chatbot.py RichTextContent/from_dict.
const richMessage = {
  msgId: 'rich-message',
  conversationType: '1',
  conversationId: 'single',
  senderId: 'sender',
  senderStaffId: 'staff',
  robotCode: 'robot',
  msgtype: 'richText',
  content: {
    richText: [
      { type: 'picture', downloadCode: 'first-picture' },
      { type: 'picture', downloadCode: 'second-picture' }
    ]
  }
}

function robotFrame(messageId: string, message: unknown): string {
  return JSON.stringify({
    type: 'CALLBACK',
    headers: { topic: '/v1.0/im/bot/messages/get', messageId },
    data: JSON.stringify(message)
  })
}

test.each([
  { cap: 'attachment count', maxAttachments: 1, maxTotalMediaBytes: 1000 },
  { cap: 'aggregate bytes', maxAttachments: 2, maxTotalMediaBytes: 96 }
])(
  'DingTalk ACKs a known $cap rejection without interrupting Stream',
  async (worker) => {
    vi.stubEnv('DING_LIMIT_SECRET', 'secret')

    // A complete one-pixel PNG; only its actual HTTP byte count is relevant here.
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP4/x8AAwAB/2+Bq7YAAAAASUVORK5CYII=',
      'base64'
    )

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
      return { body: bytes, headers: { 'content-type': 'image/png' } }
    })

    websocket = remote.ws
    downloadUrl = `${remote.http}/picture.png`

    const local = await limitsRuntime({
      maxMediaBytes: 128,
      maxTotalMediaBytes: worker.maxTotalMediaBytes,
      maxAttachments: worker.maxAttachments
    })

    try {
      await local.start()
      const socket = remote.sockets[0]
      if (!socket) {
        throw new Error('missing_stream_socket')
      }
      for (const messageId of ['over-cap', 'over-cap-redelivery']) {
        socket.send(robotFrame(messageId, richMessage))
        await expect
          .poll(() => remote.frames)
          .toContainEqual({
            code: 200,
            headers: { contentType: 'application/json', messageId },
            message: 'OK',
            data: '{"response":null}'
          })
      }
      socket.send(
        robotFrame('text-after-policy', {
          ...richMessage,
          msgId: 'valid-text',
          msgtype: 'text',
          text: { content: 'question after rejected rich text' }
        })
      )
      await expect
        .poll(() => remote.frames)
        .toContainEqual({
          code: 200,
          headers: {
            contentType: 'application/json',
            messageId: 'text-after-policy'
          },
          message: 'OK',
          data: '{"response":null}'
        })
      const saved = await records(local.storage)
      expect(saved).toHaveLength(1)
      expect(saved[0]?.snapshot.text).toBe('question after rejected rich text')
      expect(remote.sockets).toHaveLength(1)
    } finally {
      await local.close()
    }
  }
)
