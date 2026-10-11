import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { z } from 'zod'
import { createWeComChannel } from '../src/index.js'
import { wireText } from '../src/transport.js'
import { assemble, peer, records, temporaryDatabase } from './test-support.js'

installPeerNetwork()

test('WeCom decrypts pure-media input into SQLite and uploads original bytes after restart', async () => {
  vi.stubEnv('WECOM_MEDIA_SECRET', 'secret')
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  const key = Buffer.alloc(32, 7)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)

  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([bytes, Buffer.alloc(21, 21)])),
    cipher.final()
  ])

  const remote = await peer(
    () => ({
      body: encrypted,
      headers: { 'content-type': 'application/octet-stream' }
    }),
    (socket) => {
      socket.on('message', (raw) => {
        const frame = z
          .object({
            cmd: z.string(),
            headers: z.object({ req_id: z.string() })
          })
          .parse(JSON.parse(wireText(raw)))

        let body
        if (frame.cmd === 'aibot_upload_media_init') {
          body = { upload_id: 'upload-1' }
        }
        if (frame.cmd === 'aibot_upload_media_finish') {
          body = { media_id: 'media-1' }
        }
        socket.send(
          JSON.stringify({
            headers: frame.headers,
            errcode: 0,
            ...(body ? { body } : {})
          })
        )
      })
    }
  )

  const config = {
    botId: 'robot',
    secret: { env: 'WECOM_MEDIA_SECRET' }
  }

  const filename = await temporaryDatabase()
  const first = createWeComChannel()

  const local = await assemble(
    first,
    config,
    [{ chatId: 'user', senderId: 'user' }],
    filename
  )

  await local.start()
  remote.sockets[0]?.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback' },
      body: {
        msgid: 'image-1',
        aibotid: 'robot',
        chattype: 'single',
        from: { userid: 'user' },
        msgtype: 'image',
        image: { url: `${remote.http}/image`, aeskey: key.toString('base64') }
      }
    })
  )
  await expect.poll(async () => (await records(local.storage)).length).toBe(1)
  const inbound = (await records(local.storage))[0]
  expect(inbound?.snapshot.text).toBe('')
  expect(inbound?.snapshot.attachments?.[0]).toMatchObject({
    kind: 'image',
    mimeType: 'image/png',
    size: 11
  })
  await first.stop?.()
  await local.storage.close()
  const plugin = createWeComChannel()

  const restarted = await assemble(
    plugin,
    config,
    [{ chatId: 'user', senderId: 'user' }],
    filename
  )

  await restarted.start()
  const scoped = restarted.principal()
  const task = (await restarted.storage.listInbound({ limit: 10 }))[0]?.snapshot
  if (!task?.attachments?.[0]) {
    throw new Error('missing_durable_media')
  }
  expect(
    await scoped.sendMessage({
      replyTo: task.requestId,
      idempotencyKey: 'media-result',
      text: 'caption',
      attachments: [task.attachments[0].id]
    })
  ).toMatchObject({ status: 'queued' })
  await restarted.runtime.processDue()

  const chunk = remote.frames.find(
    (raw) =>
      z.object({ cmd: z.string().optional() }).parse(raw).cmd ===
      'aibot_upload_media_chunk'
  )

  expect(chunk).toMatchObject({
    body: { chunk_index: 0, base64_data: bytes.toString('base64') }
  })
  expect(remote.frames).toContainEqual(
    expect.objectContaining({
      cmd: 'aibot_send_msg',
      body: {
        chatid: 'user',
        chat_type: 1,
        msgtype: 'image',
        image: { media_id: 'media-1' }
      }
    })
  )
  expect(remote.frames).toContainEqual(
    expect.objectContaining({
      cmd: 'aibot_send_msg',
      body: {
        chatid: 'user',
        chat_type: 1,
        msgtype: 'markdown',
        markdown: { content: 'caption' }
      }
    })
  )
})
