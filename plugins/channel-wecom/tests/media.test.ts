import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { z } from 'zod'
import { createWeComChannel } from '../src/index.js'
import { wireText } from '../src/transport.js'
import { assemble, peer, records, temporaryDatabase } from './test-support.js'
import {
  callbackConfig,
  callbackKey,
  callbackMessage,
  callbackRequest
} from './callback-peer.js'

installPeerNetwork()

// Native response metadata: WecomTeam/aibot-node-sdk at
// 80615b987ef69c6028ad764924609247c0725955, src/api.ts downloadFileRaw;
// HTTP callback decryption: WecomTeam/wecom-openclaw-plugin at
// 3b1cbe3e664352821758d99ae5907f5620fce26e, src/webhook/media.ts.
test.each(['websocket', 'webhook'] as const)(
  'WeCom %s keeps the native download filename when the callback has no filename',
  async (mode) => {
    vi.stubEnv('WECOM_MEDIA_SECRET', 'secret')
    vi.stubEnv('CALLBACK_TOKEN', 'callback-token')
    vi.stubEnv(
      'CALLBACK_KEY',
      callbackKey.toString('base64').replace(/=+$/u, '')
    )
    const bytes = Buffer.from('file payload')

    const cipher = createCipheriv(
      'aes-256-cbc',
      callbackKey,
      callbackKey.subarray(0, 16)
    )

    cipher.setAutoPadding(false)

    const encrypted = Buffer.concat([
      cipher.update(Buffer.concat([bytes, Buffer.alloc(20, 20)])),
      cipher.final()
    ])

    const remote = await peer(
      () => ({
        body: encrypted,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition':
            "attachment; filename=report.pdf; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"
        }
      }),
      (socket) => {
        socket.on('message', (raw) => {
          const frame = z
            .object({ headers: z.object({ req_id: z.string() }) })
            .parse(JSON.parse(wireText(raw)))

          socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
        })
      }
    )

    const config =
      mode === 'webhook'
        ? callbackConfig
        : {
            botId: 'robot',
            secret: { env: 'WECOM_MEDIA_SECRET' }
          }

    const host = await assemble(createWeComChannel(), config, [
      { chatId: 'user', senderId: 'user' }
    ])

    await host.start()

    const body = {
      ...callbackMessage('native-file'),
      text: undefined,
      msgtype: 'file',
      file: {
        url: `${remote.http}/download`,
        ...(mode === 'websocket'
          ? { aeskey: callbackKey.toString('base64') }
          : {})
      }
    }

    if (mode === 'webhook') {
      expect((await host.runtime.fetch(callbackRequest(body))).status).toBe(200)
    } else {
      remote.sockets[0]?.send(
        JSON.stringify({
          cmd: 'aibot_msg_callback',
          headers: { req_id: 'native-file' },
          body
        })
      )
    }
    await expect.poll(async () => (await records(host.storage)).length).toBe(1)
    expect(
      (await records(host.storage))[0]?.snapshot.attachments?.[0]
    ).toMatchObject({
      kind: 'file',
      fileName: '报告.pdf',
      size: 12
    })
    expect(remote.requests).toMatchObject([
      { method: 'GET', path: '/download' }
    ])
  }
)

// Native SDK: WecomTeam/aibot-node-sdk at
// 80615b987ef69c6028ad764924609247c0725955, src/client.ts uploadMedia.
// Its executable uploader uses zero-based indices despite the type comment.
test('WeCom sends a file larger than two native upload chunks without changing its bytes', async () => {
  vi.stubEnv('WECOM_MEDIA_SECRET', 'secret')

  const remote = await peer(
    () => ({ status: 404 }),
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
          body = { upload_id: 'large-upload' }
        }
        if (frame.cmd === 'aibot_upload_media_finish') {
          body = { media_id: 'large-file' }
        }
        socket.send(
          JSON.stringify({ headers: frame.headers, errcode: 0, body })
        )
      })
    }
  )

  const host = await assemble(
    createWeComChannel(),
    {
      botId: 'robot',
      secret: { env: 'WECOM_MEDIA_SECRET' },
      recipientTypes: { user: 'single' }
    },
    [{ chatId: 'user', senderId: 'user' }]
  )

  await host.start()
  const principal = host.principal()
  const channel = (await principal.status()).channels[0]?.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }

  const bytes = Buffer.concat([
    Buffer.alloc(524_288, 17),
    Buffer.alloc(524_288, 42),
    Buffer.from([7, 8, 9])
  ])

  await principal.sendMessage({
    channel,
    text: '',
    attachments: [
      {
        kind: 'file',
        mimeType: 'application/octet-stream',
        fileName: 'large.bin',
        data: bytes
      }
    ]
  })
  await host.runtime.processDue()

  const frames = remote.frames.map((raw) =>
    z.object({ cmd: z.string(), body: z.unknown() }).parse(raw)
  )

  expect(frames.map((frame) => frame.cmd)).toEqual([
    'aibot_subscribe',
    'aibot_upload_media_init',
    'aibot_upload_media_chunk',
    'aibot_upload_media_chunk',
    'aibot_upload_media_chunk',
    'aibot_upload_media_finish',
    'aibot_send_msg'
  ])
  expect(frames[1]?.body).toEqual({
    type: 'file',
    filename: 'large.bin',
    total_size: 1_048_579,
    total_chunks: 3
  })

  const chunks = frames.slice(2, 5).map((frame) =>
    z
      .object({
        upload_id: z.string(),
        chunk_index: z.number(),
        base64_data: z.string()
      })
      .parse(frame.body)
  )

  expect(chunks.map((chunk) => chunk.chunk_index)).toEqual([0, 1, 2])
  expect(chunks.map((chunk) => chunk.upload_id)).toEqual([
    'large-upload',
    'large-upload',
    'large-upload'
  ])
  expect(
    chunks.map((chunk) => Buffer.from(chunk.base64_data, 'base64').length)
  ).toEqual([524_288, 524_288, 3])
  expect(
    Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk.base64_data, 'base64'))
    )
  ).toEqual(bytes)
  expect(frames[5]?.body).toEqual({ upload_id: 'large-upload' })
  expect(frames[6]?.body).toEqual({
    chatid: 'user',
    chat_type: 1,
    msgtype: 'file',
    file: { media_id: 'large-file' }
  })
  expect((await host.storage.listOutbound({ limit: 10 }))[0]?.status).toBe(
    'sent'
  )
})

// Native negative ACK contract: aibot-node-sdk at
// 80615b987ef69c6028ad764924609247c0725955, src/ws.ts handleReplyAck
// And src/client.ts uploadMedia: nonzero upload ACKs reject before media send.
test.each([
  'aibot_upload_media_init',
  'aibot_upload_media_chunk',
  'aibot_upload_media_finish'
])(
  'WeCom retries a rejected %s without sending unfinished media',
  async (failedCommand) => {
    vi.stubEnv('WECOM_MEDIA_SECRET', 'secret')

    const remote = await peer(
      () => ({ status: 404 }),
      (socket) => {
        socket.on('message', (raw) => {
          const frame = z
            .object({
              cmd: z.string(),
              headers: z.object({ req_id: z.string() })
            })
            .parse(JSON.parse(wireText(raw)))

          socket.send(
            JSON.stringify({
              headers: frame.headers,
              errcode: frame.cmd === failedCommand ? -1 : 0,
              body:
                frame.cmd === 'aibot_upload_media_init'
                  ? { upload_id: 'upload-failure' }
                  : undefined
            })
          )
        })
      }
    )

    const host = await assemble(
      createWeComChannel(),
      {
        botId: 'robot',
        secret: { env: 'WECOM_MEDIA_SECRET' },
        recipientTypes: { user: 'single' }
      },
      [{ chatId: 'user', senderId: 'user' }]
    )

    await host.start()
    const principal = host.principal()
    const channel = (await principal.status()).channels[0]?.channel.id
    if (!channel) {
      throw new Error('missing_channel')
    }
    await principal.sendMessage({
      channel,
      text: '',
      attachments: [
        {
          kind: 'file',
          mimeType: 'application/octet-stream',
          fileName: 'small.txt',
          data: Buffer.from('payload')
        }
      ]
    })
    await host.runtime.processDue()

    const commands = remote.frames.map(
      (raw) => z.object({ cmd: z.string() }).parse(raw).cmd
    )

    expect(commands).toContain(failedCommand)
    expect(commands.at(-1)).toBe(failedCommand)
    expect(commands).not.toContain('aibot_send_msg')
    expect((await host.storage.listOutbound({ limit: 10 }))[0]).toMatchObject({
      status: 'pending',
      errorCode: 'media_upload_unavailable'
    })
  }
)

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
      channel: task.channel.id,
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
