import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import type { MediaKind, SendInput } from '@relanox/sdk'
import { z } from 'zod'
import { createQqChannel } from '../src/index.js'
import { wireText } from '../src/transport.js'
import {
  assemble,
  peer,
  records,
  sendInput
} from '../../channel-wecom/tests/test-support.js'

installPeerNetwork()

const smallBytes = Buffer.from([10, 20, 30, 40, 50])

const formats = [
  {
    kind: 'image',
    mimeType: 'image/png',
    fileName: 'picture.png',
    fileType: 1
  },
  {
    kind: 'audio',
    mimeType: 'audio/silk',
    fileName: 'voice.silk',
    fileType: 3
  },
  { kind: 'video', mimeType: 'video/mp4', fileName: 'clip.mp4', fileType: 2 },
  {
    kind: 'file',
    mimeType: 'application/pdf',
    fileName: 'report.pdf',
    fileType: 4
  }
] as const

type Fault =
  | 'missing'
  | 'duplicate'
  | 'length'
  | 'redirect'
  | 'transient'
  | 'prepare_timeout'
  | 'message_timeout'

function prepareResponse(
  origin: string,
  size: number,
  fault?: Fault
):
  | {
      body: {
        code: number
        upload_id?: never
        block_size?: never
        parts?: never
      }
    }
  | {
      body: {
        upload_id: string
        block_size: string
        parts: { index: number; presigned_url: string; block_size: string }[]
        code?: never
      }
    } {
  if (fault === 'prepare_timeout') {
    return { body: { code: 850_027 } }
  }
  const blockSize = Math.ceil(size / 2)

  const parts = [0, 1].map((index) => ({
    index,
    presigned_url: `${origin}/signed/${index}?signature=opaque`,
    block_size: String(Math.min(blockSize, size - index * blockSize))
  }))

  if (fault === 'missing') {
    parts.pop()
  }
  if (fault === 'duplicate' && parts[1]) {
    parts[1].index = 0
  }
  if (fault === 'length' && parts[1]) {
    parts[1].block_size = String(blockSize)
  }
  return {
    body: { upload_id: 'native-upload', block_size: String(blockSize), parts }
  }
}

async function fixture(
  group = false,
  bytes = smallBytes,
  fault?: Fault
): Promise<{
  remote: Awaited<ReturnType<typeof peer>>
  local: Awaited<ReturnType<typeof assemble>>
  plugin: ReturnType<typeof createQqChannel>
  base: string
  blockSize: number
  recover(this: void): void
}> {
  vi.stubEnv('QQ_MEDIA_SECRET', 'secret')
  let websocket = ''
  let failing = fault !== undefined
  const base = group ? '/v2/groups/group' : '/v2/users/user'
  const blockSize = Math.ceil(bytes.length / 2)

  const remote = await peer(
    (request) => {
      if (request.path === '/app/getAppAccessToken') {
        return { body: { access_token: 'native-token', expires_in: 7200 } }
      }
      if (request.path === '/gateway') {
        return { body: { url: websocket } }
      }
      if (request.path === '/attachment') {
        return {
          body: bytes,
          headers: { 'content-type': 'application/octet-stream' }
        }
      }
      if (request.path === `${base}/upload_prepare`) {
        return prepareResponse(
          remote.http,
          bytes.length,
          failing ? fault : undefined
        )
      }
      if (request.path.startsWith('/signed/')) {
        if (failing && fault === 'redirect') {
          return {
            status: 307,
            headers: { location: `${remote.http}/redirect-target` }
          }
        }
        return { status: failing && fault === 'transient' ? 503 : 200 }
      }
      if (request.path === `${base}/files`) {
        return { body: { file_info: 'opaque-file-info', ttl: 60 } }
      }
      if (
        request.path === `${base}/messages` &&
        failing &&
        fault === 'message_timeout'
      ) {
        return { body: { code: 850_027 } }
      }
      return { body: { id: 'sent-media' } }
    },
    (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }))
      socket.on('message', (raw) => {
        const received = z
          .object({ op: z.number() })
          .parse(JSON.parse(wireText(raw)))

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
        if (received.op === 1) {
          socket.send(JSON.stringify({ op: 11 }))
        }
      })
    }
  )

  websocket = remote.ws
  const plugin = createQqChannel()

  const local = await assemble(
    plugin,
    {
      appId: 'app',
      clientSecret: { env: 'QQ_MEDIA_SECRET' }
    },
    [{ chatId: group ? 'group' : 'user', senderId: group ? 'member' : 'user' }]
  )

  return {
    remote,
    local,
    plugin,
    base,
    blockSize,
    recover: () => {
      failing = false
    }
  }
}

function assertUpload(
  remote: Awaited<ReturnType<typeof fixture>>['remote'],
  base: string,
  bytes: Buffer,
  blockSize: number
): void {
  const parts = remote.requests.filter((request) =>
    request.path.startsWith('/signed/')
  )

  expect(parts.map((part) => part.path)).toEqual([
    '/signed/0?signature=opaque',
    '/signed/1?signature=opaque'
  ])
  for (const [index, part] of parts.entries()) {
    if (!Buffer.isBuffer(part.body)) {
      throw new TypeError('non_binary_upload')
    }
    expect(
      part.body.equals(
        bytes.subarray(
          index * blockSize,
          Math.min(bytes.length, (index + 1) * blockSize)
        )
      )
    ).toBe(true)
  }
  for (const part of parts) {
    expect(part.method).toBe('PUT')
    expect(part.headers.authorization).toBeUndefined()
    expect(part.headers['content-type']).toBe('application/octet-stream')
  }
  for (const request of remote.requests.filter((item) =>
    item.path.startsWith(base)
  )) {
    expect(request.method).toBe('POST')
    expect(request.headers.authorization).toBe('QQBot native-token')
  }
  expect(
    remote.requests.some((request) => request.path.startsWith('/media/'))
  ).toBe(false)
}

test.each(
  [false, true].flatMap((group) =>
    formats.map((format) => ({
      kind: format.kind,
      mimeType: format.mimeType,
      fileName: format.fileName,
      fileType: format.fileType,
      group,
      chat: group ? 'group' : 'C2C'
    }))
  )
)(
  'QQ $chat relays $kind through SQLite and native binary parts without publication',
  async (format) => {
    const { group } = format
    const { remote, local, base, blockSize } = await fixture(group)
    await local.start()
    await expect.poll(() => remote.frames.length).toBeGreaterThan(0)
    remote.sockets[0]?.send(
      JSON.stringify({
        op: 0,
        s: 2,
        t: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
        d: {
          id: 'file-in',
          content: '',
          timestamp: new Date().toISOString(),
          message_type: 7,
          author: group ? { member_openid: 'member' } : { user_openid: 'user' },
          ...(group ? { group_openid: 'group' } : {}),
          attachments: [
            {
              url: `${remote.http}/attachment`,
              filename: format.fileName,
              content_type: format.mimeType
            }
          ]
        }
      })
    )
    await expect.poll(async () => (await records(local.storage)).length).toBe(1)
    const scoped = local.principal()
    const item = (await local.storage.listInbound({ limit: 10 }))[0]?.snapshot
    if (!item?.attachments?.[0] || !scoped.media) {
      throw new Error('missing_media')
    }

    const stored = await scoped.media.read({
      requestId: item.requestId,
      mediaId: item.attachments[0].id
    })

    expect(stored?.data).toEqual(new Uint8Array(smallBytes))
    await scoped.sendMessage({
      replyTo: item.requestId,
      idempotencyKey: 'file-result',
      text: 'caption',
      attachments: [item.attachments[0].id]
    })
    await local.runtime.processDue()
    assertUpload(remote, base, smallBytes, blockSize)
    expect(
      remote.requests.find(
        (request) => request.path === `${base}/upload_prepare`
      )?.body
    ).toEqual({
      file_type: format.fileType,
      file_size: '5',
      file_name: format.fileName,
      md5: 'f4c4d144ac78a1311e4425fd2d101019',
      sha1: '42ecbc0cca81490182072bad2610f1ecb2c077e2',
      md5_10m: 'f4c4d144ac78a1311e4425fd2d101019'
    })
    expect(
      remote.requests
        .filter((request) => request.path === `${base}/upload_part_finish`)
        .map((request) => request.body)
    ).toEqual([
      {
        upload_id: 'native-upload',
        part_index: 0,
        block_size: '3',
        md5: '7f49b84d0bbc38e96493718013baace6'
      },
      {
        upload_id: 'native-upload',
        part_index: 1,
        block_size: '2',
        md5: 'ed670cfb05a638ac7bf9be8a09775e91'
      }
    ])
    expect(
      remote.requests.find((request) => request.path === `${base}/files`)?.body
    ).toEqual({
      file_type: format.fileType,
      file_name: format.fileName,
      upload_id: 'native-upload',
      srv_send_msg: false
    })
    expect(
      remote.requests
        .filter((request) => request.path === `${base}/messages`)
        .map((request) => request.body)
    ).toEqual([
      { content: 'caption', msg_type: 0, msg_id: 'file-in', msg_seq: 1 },
      {
        content: '',
        msg_type: 7,
        media: { file_info: 'opaque-file-info' },
        msg_id: 'file-in',
        msg_seq: 2
      }
    ])
  }
)

function outbound(bytes: Buffer): SendInput {
  const reference = {
    id: 'asset',
    kind: 'file' as MediaKind,
    mimeType: 'application/pdf',
    fileName: 'report.pdf',
    size: bytes.length,
    sha256: '0'.repeat(64)
  }

  return {
    ...sendInput('qq', 'user', {
      type: 'c2c',
      msgId: 'original',
      messageAt: Date.now(),
      scope: { appId: 'app', apiBase: 'https://api.sgroup.qq.com/' }
    }),
    chunk: {
      text: '',
      idempotencyKey: 'media:0',
      state: null,
      media: reference
    },
    media: { reference, data: new Uint8Array(bytes) }
  }
}

test('QQ uploads beyond direct JSON size limits and hashes exactly the first 10002432 bytes', async () => {
  const bytes = Buffer.alloc(10_002_433, 7)
  const { remote, plugin, base, blockSize } = await fixture(false, bytes)
  expect(await plugin.send(outbound(bytes))).toMatchObject({
    status: 'sent'
  })
  assertUpload(remote, base, bytes, blockSize)
  expect(
    remote.requests.find((request) => request.path === `${base}/upload_prepare`)
      ?.body
  ).toMatchObject({
    file_size: '10002433',
    md5: 'db3e3f767ee5050b6404b5a680d72be4',
    sha1: '7020530634e2141e69074d672590c006d636741f',
    md5_10m: '94a14cd6c674405f82db4bfe963e9179'
  })
})

test.each([
  'missing',
  'duplicate',
  'length',
  'redirect',
  'transient',
  'prepare_timeout'
] as const)(
  'QQ %s upload failure sends no message and the same delivery can retry',
  async (fault) => {
    const { remote, plugin, base, recover } = await fixture(
      false,
      smallBytes,
      fault
    )

    const input = outbound(smallBytes)
    expect(await plugin.send(input)).toMatchObject({ status: 'retryable' })
    expect(
      remote.requests.filter(
        (request) =>
          request.path === `${base}/messages` ||
          request.path === `${base}/files`
      )
    ).toEqual([])
    expect(
      remote.requests.some((request) => request.path === '/redirect-target')
    ).toBe(false)
    expect(
      remote.requests.filter(
        (request) => request.path === `${base}/upload_part_finish`
      )
    ).toEqual([])
    if (['missing', 'duplicate', 'length'].includes(fault)) {
      expect(
        remote.requests.filter((request) => request.path.startsWith('/signed/'))
      ).toEqual([])
    }
    recover()
    expect(await plugin.send(input)).toMatchObject({ status: 'sent' })
    expect(
      remote.requests
        .filter((request) => request.path === `${base}/messages`)
        .map((request) => request.body)
    ).toEqual([
      {
        content: '',
        msg_type: 7,
        media: { file_info: 'opaque-file-info' },
        msg_id: 'original',
        msg_seq: 1
      }
    ])
  }
)

test('QQ upload retry classification does not change final message error handling', async () => {
  const { plugin } = await fixture(false, smallBytes, 'message_timeout')
  expect(await plugin.send(outbound(smallBytes))).toEqual({
    status: 'rejected',
    errorCode: 'qq_850027'
  })
})
