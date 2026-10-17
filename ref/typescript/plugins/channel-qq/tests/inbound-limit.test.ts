import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createQqChannel } from '../src/index.js'
import { wireText } from '../../channel-wecom/src/transport.js'
import {
  assemble,
  peer,
  records
} from '../../channel-wecom/tests/test-support.js'

installPeerNetwork()

// Exercise an explicit 25 MiB relay limit independently of the default upload allowance.
// https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
// Native replay/RESUMED dispatch is handled independently of the READY state:
// https://github.com/tencent-connect/qqbot-nodejs/blob/f77fab29e78f5c69a4194237aab81e12f41afb3e/src/protocol/gateway/gateway-connection.ts
async function fixture(
  failure: 'byte_limit' | 'transient',
  kind: 'file' | 'image' | 'video' | 'voice' | 'asr' | 'mixed' = 'file'
): Promise<{
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
                content: kind === 'file' ? '' : 'caption',
                timestamp: new Date().toISOString(),
                message_type: 0,
                author: { user_openid: 'user' },
                attachments: [
                  {
                    url: `${remote.http}/file`,
                    filename: {
                      file: 'file.bin',
                      image: 'image.png',
                      video: 'clip.mp4',
                      voice: 'file.bin',
                      asr: 'file.bin',
                      mixed: 'file.bin'
                    }[kind],
                    content_type: {
                      file: 'file',
                      image: 'image/png',
                      video: 'file',
                      voice: 'voice',
                      asr: 'voice',
                      mixed: 'file'
                    }[kind],
                    ...(kind === 'asr'
                      ? { asr_refer_text: 'QQ recognized speech' }
                      : {})
                  },
                  ...(kind === 'mixed'
                    ? [
                        {
                          url: `${remote.http}/file`,
                          filename: 'kept.txt',
                          content_type: 'text/plain'
                        }
                      ]
                    : [])
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
    [{ chatId: 'user', senderId: 'user' }],
    ':memory:',
    undefined,
    { maxMediaBytes: 25 * 1024 * 1024 }
  )

  return { remote, local }
}

// Real SQLite catches message loss on CDN failure; no production-only test hook is needed.
test.each(['byte_limit', 'transient'] as const)(
  'QQ retains a file description after %s and accepts following text',
  async (failure) => {
    const { remote, local } = await fixture(failure)
    await local.start()
    await expect
      .poll(async () => (await records(local.storage)).length, {
        timeout: 3000
      })
      .toBe(2)
    const saved = await records(local.storage)
    expect(
      saved.find((r) => r.snapshot.target.replyToId === 'file-message')
        ?.snapshot
    ).toMatchObject({ text: '[Attachment: file.bin]' })
    expect(
      saved.find((r) => r.snapshot.target.replyToId === 'file-message')
        ?.snapshot.attachments ?? []
    ).toHaveLength(0)
    expect(
      saved.find((r) => r.snapshot.target.replyToId === 'following-message')
        ?.snapshot.text
    ).toBe('Still here')
    expect(
      remote.requests.filter((request) => request.path === '/file')
    ).toHaveLength(1)
    expect(remote.sockets).toHaveLength(1)
  }
)

// Native ASR metadata: SDK 1.0.5 src/protocol/types.ts MessageAttachment.
// These cases catch silent image-only loss or accidental fake stored-media references.
test.each(['image', 'video', 'voice', 'asr', 'mixed'] as const)(
  'QQ preserves %s context when its CDN download fails',
  async (kind) => {
    const { remote, local } = await fixture('transient', kind)
    await local.start()
    await expect.poll(async () => (await records(local.storage)).length).toBe(2)

    const message = (await records(local.storage)).find(
      (record) => record.snapshot.target.replyToId === 'file-message'
    )?.snapshot

    const fallback = {
      image: `[Image: ${remote.http}/file]`,
      video: '[Attachment: clip.mp4]',
      voice: '[Voice message - transcription unavailable]',
      asr: 'QQ recognized speech',
      mixed: '[Attachment: file.bin]'
    }[kind]

    expect(message?.text).toBe(`caption\n${fallback}`)
    expect(message?.context).toEqual(
      kind === 'image'
        ? {
            remoteImages: [
              { url: `${remote.http}/file`, fileName: 'image.png' }
            ]
          }
        : null
    )
    expect(message?.attachments ?? []).toHaveLength(kind === 'mixed' ? 1 : 0)
    if (kind === 'mixed') {
      expect(message?.attachments?.[0]).toMatchObject({
        kind: 'file',
        fileName: 'kept.txt',
        size: 11
      })
    }
    expect(remote.sockets).toHaveLength(1)
  }
)
