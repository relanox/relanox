import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createQqChannel } from '../src/index.js'
import { wireText } from '../src/transport.js'
import {
  assemble,
  peer,
  records
} from '../../channel-wecom/tests/test-support.js'

installPeerNetwork()

// QQ supports files up to 200 MB; the relay's default individual limit is 25 MiB.
// https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
// Native replay/RESUMED dispatch is handled independently of the READY state:
// https://github.com/tencent-connect/qqbot-nodejs/blob/f77fab29e78f5c69a4194237aab81e12f41afb3e/src/protocol/gateway/gateway-connection.ts
async function fixture(failure: 'byte_limit' | 'transient'): Promise<{
  remote: Awaited<ReturnType<typeof peer>>
  local: Awaited<ReturnType<typeof assemble>>
}> {
  vi.stubEnv('QQ_SECRET', 'secret')
  let address = ''
  let downloads = 0

  const bytes =
    failure === 'byte_limit'
      ? Buffer.alloc(26 * 1024 * 1024, 7)
      : Buffer.from('native-file')

  const remote = await peer(
    (request) => {
      if (request.path === '/app/getAppAccessToken') {
        return { body: { access_token: 'token', expires_in: 7200 } }
      }
      if (request.path === '/file') {
        downloads++
        if (failure === 'transient' && downloads === 1) {
          return { status: 503 }
        }
        return {
          body: bytes,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length)
          }
        }
      }
      return { body: { url: address } }
    },
    (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }))
      socket.on('message', (data) => {
        const received = z
          .object({ op: z.number() })
          .parse(JSON.parse(wireText(data)))

        if (received.op === 2 || received.op === 6) {
          if (received.op === 2) {
            socket.send(
              JSON.stringify({
                op: 0,
                s: 1,
                t: 'READY',
                d: { session_id: 'session' }
              })
            )
          }
          socket.send(
            JSON.stringify({
              op: 0,
              s: 2,
              t: 'C2C_MESSAGE_CREATE',
              d: {
                id: 'file-message',
                content: '',
                timestamp: new Date().toISOString(),
                message_type: 0,
                author: { user_openid: 'user' },
                attachments: [
                  {
                    url: `${remote.http}/file`,
                    filename: 'file.bin',
                    content_type: 'file'
                  }
                ]
              }
            })
          )
          socket.send(
            JSON.stringify({
              op: 0,
              s: 3,
              t: 'C2C_MESSAGE_CREATE',
              d: {
                id: 'following-message',
                content: 'Still here',
                timestamp: new Date().toISOString(),
                message_type: 0,
                author: { user_openid: 'user' }
              }
            })
          )
          if (received.op === 6) {
            socket.send(JSON.stringify({ op: 0, s: 4, t: 'RESUMED', d: '' }))
          }
        }
        if (received.op === 1) {
          socket.send(JSON.stringify({ op: 11 }))
        }
      })
    }
  )

  address = remote.ws

  const local = await assemble(
    createQqChannel(),
    { appId: 'app', clientSecret: { env: 'QQ_SECRET' } },
    [{ chatId: 'user', senderId: 'user' }]
  )

  return { remote, local }
}

test('QQ progresses past an attachment rejected by the relay byte limit', async () => {
  const { remote, local } = await fixture('byte_limit')
  await local.start()
  await expect
    .poll(async () => (await records(local.storage)).length, { timeout: 3000 })
    .toBe(1)
  expect((await records(local.storage))[0]?.snapshot.text).toBe('Still here')
  expect(
    remote.requests.filter((request) => request.path === '/file')
  ).toHaveLength(1)
})

test('QQ resumes an unavailable attachment before processing later messages', async () => {
  const { remote, local } = await fixture('transient')
  await local.start()
  await expect
    .poll(async () => (await records(local.storage)).length, { timeout: 4000 })
    .toBe(2)
  expect(remote.frames).toContainEqual({
    op: 6,
    d: { token: 'QQBot token', session_id: 'session', seq: 1 }
  })
  expect(
    remote.requests.filter((request) => request.path === '/file')
  ).toHaveLength(2)
  const saved = await records(local.storage)
  expect(saved.map((record) => record.snapshot.target.replyToId)).toEqual(
    expect.arrayContaining(['file-message', 'following-message'])
  )

  const file = saved.find(
    (record) => record.snapshot.target.replyToId === 'file-message'
  )?.snapshot

  const media = local.principal().media
  if (!file?.attachments?.[0] || !media) {
    throw new Error('missing_recovered_attachment')
  }
  expect(
    (
      await media.read({
        channelId: file.channel.id,
        mediaId: file.attachments[0].id
      })
    )?.data
  ).toEqual(new Uint8Array(Buffer.from('native-file')))
})
