import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import type { MediaKind, SendInput } from '@relanox/sdk'
import { z } from 'zod'
import { createQqChannel } from '../src/index.js'
import { wireText } from '../../channel-wecom/src/transport.js'
import {
  assemble,
  peer,
  records,
  sendInput
} from '../../channel-wecom/tests/test-support.js'

installPeerNetwork()

const nativeSequence: unknown = expect.any(Number)

test.each([false, true])(
  'QQ rich Markdown preserves image order and preserves the passive message ID for group=%s',
  async (group) => {
    const { remote, local, plugin, base } = await fixture(group)
    await local.start()
    await expect.poll(() => remote.frames.length).toBeGreaterThan(0)
    remote.sockets[0]?.send(
      JSON.stringify({
        op: 0,
        s: 2,
        t: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
        d: {
          id: 'rich-in',
          content: '',
          timestamp: new Date().toISOString(),
          message_type: 7,
          author: group ? { member_openid: 'member' } : { user_openid: 'user' },
          ...(group ? { group_openid: 'group' } : {}),
          attachments: [
            {
              url: `${remote.http}/attachment`,
              filename: 'image.png',
              content_type: 'image/png'
            }
          ]
        }
      })
    )
    await expect.poll(async () => (await records(local.storage)).length).toBe(1)
    const item = (await records(local.storage))[0]?.snapshot
    if (!item?.attachments?.[0] || !local.principal().media) {
      throw new Error('missing_media')
    }

    const image = await local.principal().media?.read({
      channelId: item.channel.id,
      mediaId: item.attachments[0].id
    })

    if (!image) {
      throw new Error('missing_bytes')
    }

    const input: SendInput = {
      ...sendInput('qq', item.target.chatId, item.target.data, 'rich-one'),
      channelId: item.channel.id,
      chunk: {
        text: '',
        state: null,
        idempotencyKey: 'rich-one',
        richText: [
          { type: 'text', text: '**before**' },
          { type: 'image', media: image.reference, label: 'photo' },
          { type: 'text', text: 'after' }
        ]
      },
      richMedia: [image]
    }

    expect(plugin.capabilities.richText).toBeDefined()
    expect(await plugin.send(input)).toMatchObject({ status: 'sent' })
    expect(await plugin.send(input)).toMatchObject({ status: 'sent' })

    const messages = remote.requests.filter(
      (request) => request.path === `${base}/messages`
    )

    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message.headers.authorization).toBe('QQBot native-token')

      const richContent: unknown = expect.stringMatching(
        /^\*\*before\*\*\n\n!\[photo\]\(https:\/\/relay\.example\/[^\s]+\)\n\nafter$/u
      )

      expect(message.body).toEqual({
        msg_type: 2,
        markdown: {
          content: richContent
        },
        msg_id: 'rich-in',
        msg_seq: nativeSequence
      })
    }
    expect(
      remote.requests.some((request) =>
        request.path.includes('/upload_prepare')
      )
    ).toBe(false)
    const count = remote.requests.length
    expect(await plugin.send({ ...input, richMedia: [] })).toEqual({
      status: 'rejected',
      errorCode: 'invalid_rich_media'
    })
    expect(remote.requests).toHaveLength(count)
  }
)

const smallBytes = Buffer.from([10, 20, 30, 40, 50])

// Native attachment labels are distinct from the download response's MIME type.
// Recorded native MP4 attachments also use file; derive kind from verified MIME.
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html#schema-messageattachment
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html#schema-messageattachment
const formats = [
  {
    kind: 'image',
    mimeType: 'image/png',
    nativeContentType: 'image/png',
    fileName: 'picture.png',
    fileType: 1
  },
  {
    kind: 'audio',
    mimeType: 'audio/silk',
    nativeContentType: 'voice',
    fileName: 'voice.silk',
    fileType: 3
  },
  {
    kind: 'video',
    mimeType: 'video/mp4',
    nativeContentType: 'video/mp4',
    fileName: 'clip.mp4',
    fileType: 2
  },
  {
    kind: 'file',
    mimeType: 'application/pdf',
    nativeContentType: 'file',
    fileName: 'report.pdf',
    fileType: 4
  },
  {
    kind: 'video',
    mimeType: 'video/mp4',
    nativeContentType: 'file',
    fileName: 'VIDEO-1013.MP4',
    fileType: 2
  },
  {
    kind: 'file',
    mimeType: 'application/octet-stream',
    nativeContentType: 'voice',
    fileName: 'opaque-voice.bin',
    fileType: 4
  }
] as const

type Fault = 'redirect' | 'transient' | 'prepare_timeout' | 'message_timeout'

// QQ SDK 1.0.5 owns small/base64 and large/chunked uploads. Real peers protect the adapter's bytes, target and result mapping.
// https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/api/media-chunked.ts
function prepareResponse(
  origin: string,
  size: number,
  fault?: Fault,
  reversed = false
): {
  body:
    | { code: number }
    | {
        upload_id: string
        block_size: number
        parts: { index: number; presigned_url: string }[]
      }
} {
  if (fault === 'prepare_timeout') {
    return { body: { code: 850_027 } }
  }
  const blockSize = Math.ceil(size / 2)

  const parts = [1, 2].map((index) => ({
    index,
    presigned_url: `${origin}/signed/${index - 1}?signature=opaque`
  }))

  return {
    body: {
      upload_id: 'native-upload',
      block_size: blockSize,
      parts: reversed ? parts.toReversed() : parts
    }
  }
}

async function fixture(
  group = false,
  bytes = smallBytes,
  fault?: Fault,
  nativeShape = false,
  downloadMimeType = 'application/octet-stream'
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
          headers: { 'content-type': downloadMimeType }
        }
      }
      if (request.path === `${base}/upload_prepare`) {
        return prepareResponse(
          remote.http,
          bytes.length,
          failing ? fault : undefined,
          nativeShape
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
  const parts = remote.requests
    .filter((request) => request.path.startsWith('/signed/'))
    .toSorted((a, b) => a.path.localeCompare(b.path))

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
    expect(part.headers['content-length']).toBe(
      String(Buffer.isBuffer(part.body) ? part.body.length : 0)
    )
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
      nativeContentType: format.nativeContentType,
      fileName: format.fileName,
      fileType: format.fileType,
      group,
      chat: group ? 'group' : 'C2C'
    }))
  )
)(
  'QQ $chat relays $kind ($nativeContentType / $mimeType) through SQLite and SDK direct uploads without publication',
  async (format) => {
    const { group } = format

    const { remote, local, base } = await fixture(
      group,
      smallBytes,
      undefined,
      false,
      format.mimeType
    )

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
          message_type: 0,
          author: group ? { member_openid: 'member' } : { user_openid: 'user' },
          ...(group ? { group_openid: 'group' } : {}),
          attachments: [
            {
              url: `${remote.http}/attachment`,
              filename: format.fileName,
              content_type: format.nativeContentType
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
      channelId: item.channel.id,
      mediaId: item.attachments[0].id
    })

    expect(stored?.data).toEqual(new Uint8Array(smallBytes))
    expect(stored?.reference).toMatchObject({
      kind: format.kind,
      mimeType: format.mimeType,
      fileName: format.fileName
    })
    await scoped.sendMessage({
      channel: item.channel.id,
      idempotencyKey: 'file-result',
      text: '**caption** [link](https://example.com)',
      attachments: [item.attachments[0].id]
    })
    await local.runtime.processDue()
    expect(
      remote.requests.find((request) => request.path === `${base}/files`)?.body
    ).toEqual({
      file_type: format.fileType,
      srv_send_msg: false,
      file_data: 'ChQeKDI=',
      ...(format.fileType === 4 ? { file_name: format.fileName } : {})
    })
    expect(
      remote.requests.some((request) =>
        request.path.endsWith('/upload_prepare')
      )
    ).toBe(false)
    expect(
      remote.requests
        .filter((request) => request.path === `${base}/messages`)
        .map((request) => request.body)
    ).toEqual([
      {
        markdown: { content: '**caption** [link](https://example.com)' },
        msg_type: 2,
        msg_id: 'file-in',
        msg_seq: nativeSequence
      },
      {
        content: '',
        msg_type: 7,
        media: { file_info: 'opaque-file-info' },
        msg_id: 'file-in',
        msg_seq: nativeSequence
      }
    ])
  }
)

function outbound(bytes: Buffer, group = false): SendInput {
  const reference = {
    id: 'asset',
    kind: 'file' as MediaKind,
    mimeType: 'application/pdf',
    fileName: 'report.pdf',
    size: bytes.length,
    sha256: '0'.repeat(64)
  }

  return {
    ...sendInput('qq', group ? 'group' : 'user', {
      type: group ? 'group' : 'c2c',
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
    file_size: 10_002_433,
    md5: 'db3e3f767ee5050b6404b5a680d72be4',
    sha1: '7020530634e2141e69074d672590c006d636741f',
    md5_10m: '94a14cd6c674405f82db4bfe963e9179'
  })
})

test.each(['redirect', 'transient', 'prepare_timeout'] as const)(
  'QQ %s upload failure sends no message and the same delivery can retry',
  async (fault) => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7)
    const { remote, plugin, base, recover } = await fixture(false, bytes, fault)
    const input = outbound(bytes)
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
        msg_seq: nativeSequence
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

test.each([false, true])(
  'QQ uploads unordered native parts for group=%s',
  async (group) => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7)

    const { remote, plugin, base, blockSize } = await fixture(
      group,
      bytes,
      undefined,
      true
    )

    expect(await plugin.send(outbound(bytes, group))).toMatchObject({
      status: 'sent'
    })
    assertUpload(remote, base, bytes, blockSize)
    expect(
      remote.requests.find((request) => request.path === `${base}/files`)?.body
    ).toEqual({ upload_id: 'native-upload' })
    expect(
      remote.requests
        .filter((request) => request.path === `${base}/upload_part_finish`)
        .map((request) => request.body)
    ).toEqual([
      {
        upload_id: 'native-upload',
        part_index: 2,
        block_size: 2_621_440,
        md5: '771b0078b861fcaa2ed7d7561911ce6e'
      },
      {
        upload_id: 'native-upload',
        part_index: 1,
        block_size: 2_621_440,
        md5: '771b0078b861fcaa2ed7d7561911ce6e'
      }
    ])
  }
)

// QQ acceptance capture on 2026-10-13 returned content_type=file for MP4 and
// UTF-8 TXT attachments with application/octet-stream downloads. The remaining
// Cases vary MIME metadata to protect precedence, normalization and fallback.
// Native attachment labels: https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
const receivedMedia = [
  // The 2026-10-13 QQ recording had content_type=voice, an .amr name and
  // The Tencent-prefixed SILK header below. Also vary standard SILK with AMR metadata.
  {
    name: 'Tencent SILK with an AMR filename',
    contentType: 'voice',
    fileName: 'recording.amr',
    bytes: Buffer.from('02232153494c4b5f56331b00aa9a6f93', 'hex'),
    mimeType: 'audio/silk',
    kind: 'audio',
    fileType: 3
  },
  {
    name: 'SILK mislabeled as AMR',
    contentType: 'audio/amr',
    fileName: 'recording.amr',
    bytes: Buffer.from('#!SILK_V3\u001B\u0000audio'),
    mimeType: 'audio/silk',
    kind: 'audio',
    fileType: 3
  },
  {
    name: 'native MP4 labeled file',
    contentType: 'file',
    fileName: 'VIDEO-1013.MP4',
    bytes: Buffer.from(
      '000000186674797069736f6d0000020069736f6d6d703432',
      'hex'
    ),
    mimeType: 'video/mp4',
    kind: 'video',
    fileType: 2
  },
  {
    name: 'UTF-8 text labeled file',
    contentType: 'file',
    fileName: 'FILE-1013.txt',
    bytes: Buffer.from('RELANOX-FILE-1013\n青山不改，绿水长流。'),
    mimeType: 'text/plain',
    kind: 'file',
    fileType: 4
  },
  {
    name: 'HTTP MIME without a known extension',
    contentType: 'file',
    downloadType: 'video/mp4',
    fileName: 'download.bin',
    bytes: smallBytes,
    mimeType: 'video/mp4',
    kind: 'video',
    fileType: 2
  },
  {
    name: 'parameterized event MIME',
    contentType: 'Text/Plain; charset=utf-8',
    fileName: 'download',
    bytes: Buffer.from('known text'),
    mimeType: 'text/plain',
    kind: 'file',
    fileType: 4
  },
  {
    name: 'unknown file with invalid MIME metadata',
    contentType: 'file',
    downloadType: 'unknown',
    fileName: 'download.bin',
    bytes: smallBytes,
    mimeType: 'application/octet-stream',
    kind: 'file',
    fileType: 4
  }
] as const

test.each(
  [false, true].flatMap((group) =>
    receivedMedia.map((media) => ({ group, media }))
  )
)(
  'QQ persists and returns $media.name without changing bytes, group=$group',
  async ({ group, media }) => {
    const { remote, local, base } = await fixture(
      group,
      media.bytes,
      undefined,
      true,
      'downloadType' in media ? media.downloadType : undefined
    )

    await local.start()
    await expect.poll(() => remote.frames.length).toBeGreaterThan(0)
    remote.sockets[0]?.send(
      JSON.stringify({
        op: 0,
        s: 2,
        t: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
        d: {
          id: 'native-media',
          timestamp: new Date().toISOString(),
          message_type: 0,
          author: group ? { member_openid: 'member' } : { user_openid: 'user' },
          ...(group ? { group_openid: 'group' } : {}),
          attachments: [
            {
              url: `${remote.http}/attachment`,
              filename: media.fileName,
              content_type: media.contentType
            }
          ]
        }
      })
    )
    await expect.poll(async () => (await records(local.storage)).length).toBe(1)
    const item = (await records(local.storage))[0]?.snapshot
    const attachment = item?.attachments?.[0]
    if (!item || !attachment) {
      throw new Error('missing_media')
    }
    expect(attachment).toMatchObject({
      kind: media.kind,
      mimeType: media.mimeType,
      fileName: media.fileName,
      size: media.bytes.length
    })

    const stored = await local.principal().media?.read({
      channelId: item.channel.id,
      mediaId: attachment.id
    })

    expect(stored?.data).toEqual(new Uint8Array(media.bytes))
    await local.principal().sendMessage({
      channel: item.channel.id,
      idempotencyKey: 'native-media-reply',
      text: '',
      attachments: [attachment.id]
    })
    await local.runtime.processDue()
    expect(
      remote.requests.find((request) => request.path === `${base}/files`)?.body
    ).toMatchObject({
      file_type: media.fileType,
      file_data: media.bytes.toString('base64'),
      srv_send_msg: false
    })
    expect(
      remote.requests.find((request) => request.path === `${base}/messages`)
        ?.body
    ).toMatchObject({ msg_type: 7, media: { file_info: 'opaque-file-info' } })
  }
)

test.each(['audio/amr', 'audio/wav', 'audio/mpeg'])(
  'QQ rejects unsupported %s voice without uploading mislabeled bytes',
  async (mimeType) => {
    const { remote, plugin } = await fixture()
    const input = outbound(smallBytes)
    if (!input.media) {
      throw new Error('missing_media')
    }

    const reference = {
      ...input.media.reference,
      kind: 'audio' as const,
      mimeType
    }

    expect(
      await plugin.send({
        ...input,
        chunk: { ...input.chunk, media: reference },
        media: { ...input.media, reference }
      })
    ).toEqual({ status: 'rejected', errorCode: 'unsupported_media_format' })
    expect(
      remote.requests.some(
        (request) =>
          request.path.includes('upload') || request.path.endsWith('/messages')
      )
    ).toBe(false)
  }
)

// The SDK exposes no upload AbortSignal. A delayed real upload response must not
// Cause a fresh send after cancellation or use an expired msg_id; direct upload tests miss this race.
test.each(['abort', 'expired'] as const)(
  'QQ rechecks %s after an SDK upload before sending',
  async (reason) => {
    vi.stubEnv('QQ_MEDIA_SECRET', 'secret')
    const uploaded = Promise.withResolvers<void>()

    const remote = await peer(async (request) => {
      if (request.path === '/app/getAppAccessToken') {
        return { body: { access_token: 'token', expires_in: 7200 } }
      }
      if (request.path.endsWith('/files')) {
        await uploaded.promise
        return { body: { file_info: 'opaque', ttl: 60 } }
      }
      return { body: { id: 'sent' } }
    })

    const plugin = createQqChannel()
    await assemble(
      plugin,
      { appId: 'app', clientSecret: { env: 'QQ_MEDIA_SECRET' } },
      [{ chatId: 'group', senderId: 'member' }]
    )
    const controller = new AbortController()

    const operation = plugin.send({
      ...outbound(smallBytes, true),
      signal: controller.signal
    })

    try {
      await expect
        .poll(() =>
          remote.requests.some((request) => request.path.endsWith('/files'))
        )
        .toBe(true)
      if (reason === 'abort') {
        controller.abort()
      } else {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 360_000)
      }
      uploaded.resolve()
      expect(await operation).toMatchObject(
        reason === 'abort' ? { status: 'retryable' } : { status: 'sent' }
      )

      const sends = remote.requests.filter((request) =>
        request.path.endsWith('/messages')
      )

      if (reason === 'abort') {
        expect(sends).toEqual([])
      } else {
        expect(sends).toHaveLength(1)
        expect(sends[0]?.body).toEqual({
          msg_type: 7,
          media: { file_info: 'opaque' },
          msg_seq: 1,
          content: ''
        })
      }
    } finally {
      uploaded.resolve()
      await operation
    }
  }
)
