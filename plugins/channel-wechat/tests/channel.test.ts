import { createCipheriv, createDecipheriv } from 'node:crypto'
import type { SendInput } from '@relanox/sdk'
import { expect, it } from 'vitest'
import { z } from 'zod'
import {
  body,
  harness,
  httpPeer,
  json,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import {
  beginWechatLogin,
  createWechatChannel,
  pollWechatLogin
} from '../src/index.js'

// Wire fixtures: Tencent's official iLink API documentation (message numbering,
// Optional native fields, QR responses and CDN key encoding), independently built:
// https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
// Protect observable protocol, restart, authorization and crypto contracts. A
// Cursor saved before acceptance loses messages; a raw-vs-hex key mix-up corrupts
// Attachments. Existing channel tests exercise different protocols. All traffic
// Uses a real HTTP peer and recovery uses Core plus SQLite, with no test-only seam.

function config(base: string): {
  botId: string
  botToken: { env: string }
  apiBaseUrl: string
  cdnBaseUrl: string
  allowInsecureLoopback: boolean
} {
  return {
    botId: 'bot@im.bot',
    botToken: { env: 'WECHAT_TOKEN' },
    apiBaseUrl: base,
    cdnBaseUrl: `${base}/c2c`,
    allowInsecureLoopback: true
  }
}

function input(base: string): SendInput {
  return {
    deliveryId: 'delivery',
    channelId: 'channel',
    target: {
      channel: 'wechat',
      accountId: 'bot',
      chatId: 'alice@im.wechat',
      data: {
        botId: 'bot@im.bot',
        apiBaseUrl: `${base}/`,
        contextToken: 'context'
      }
    },
    chunk: { text: 'answer', idempotencyKey: 'delivery:0', state: null },
    chunkIndex: 0,
    signal: new AbortController().signal
  }
}

it('uses QR POST and unauthenticated status GET with verification without leaking bot credentials', async () => {
  const requests: {
    url: string
    authorization: string | undefined
    body?: unknown
  }[] = []

  const peer = await httpPeer(async (request, response) => {
    requests.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
      ...(request.method === 'POST' ? { body: await body(request) } : {})
    })
    if (request.method === 'POST') {
      json(response, {
        qrcode: 'qr+value',
        qrcode_img_content: 'https://example.com/qr'
      })
    } else {
      json(response, {
        status: 'confirmed',
        bot_token: 'secret',
        ilink_bot_id: 'bot@im.bot',
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'alice@im.wechat'
      })
    }
  })

  const options = {
    apiBaseUrl: peer.base,
    allowInsecureLoopback: true,
    signal: new AbortController().signal
  }

  expect(await beginWechatLogin(options)).toEqual({
    qrcode: 'qr+value',
    qrcode_img_content: 'https://example.com/qr'
  })
  expect(
    await pollWechatLogin({
      ...options,
      qrcode: 'qr+value',
      verifyCode: '123 456'
    })
  ).toMatchObject({ status: 'confirmed', bot_token: 'secret' })
  expect(requests).toEqual([
    {
      url: '/ilink/bot/get_bot_qrcode?bot_type=3',
      authorization: undefined,
      body: { local_token_list: [] }
    },
    {
      url: '/ilink/bot/get_qrcode_status?qrcode=qr%2Bvalue&verify_code=123+456',
      authorization: undefined
    }
  ])
})

it('persists the poll cursor and context, and deduplicates replay after reopening SQLite', async () => {
  const cursors: string[] = []
  const sendBodies: unknown[] = []

  const peer = await httpPeer(async (request, response) => {
    const raw = await body(request)
    if (request.url?.endsWith('sendmessage')) {
      sendBodies.push(raw)
      json(response, { ret: 0 })
      return
    }

    const cursor = z
      .object({ get_updates_buf: z.string() })
      .parse(raw).get_updates_buf

    cursors.push(cursor)
    expect(request.headers.authorization).toBe('Bearer token')
    expect(request.headers.authorizationtype).toBe('ilink_bot_token')
    if (cursors.length > 2) {
      return
    }

    const payload = {
      ret: 0,
      get_updates_buf: 'cursor-next',
      msgs: [
        {
          message_id: '18446744073709551615',
          from_user_id: 'alice@im.wechat',
          to_user_id: 'bot@im.bot',
          message_type: 1,
          message_state: 2,
          context_token: 'context',
          item_list: [{ type: 1, text_item: { text: 'hello' } }]
        },
        {
          message_id: 74,
          from_user_id: 'mallory',
          message_type: 1,
          context_token: 'other',
          item_list: [{ type: 1, text_item: { text: 'unauthorized' } }]
        }
      ]
    }

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify(payload).replace(
        '"message_id":"18446744073709551615"',
        '"message_id":18446744073709551615'
      )
    )
  })

  const firstPlugin = createWechatChannel({ WECHAT_TOKEN: 'token' })

  const first = await harness(
    firstPlugin,
    config(peer.base),
    [{ chatId: 'alice@im.wechat' }],
    ['alice@im.wechat'],
    `${peer.base}/dispatch`
  )

  await firstPlugin.start?.(new AbortController().signal)
  await waitFor(() => cursors.length >= 2)
  await firstPlugin.stop?.()
  expect(await first.storage.listInbound({ limit: 10 })).toHaveLength(1)
  await first.storage.close()
  const nextPlugin = createWechatChannel({ WECHAT_TOKEN: 'token' })

  const next = await harness(
    nextPlugin,
    config(peer.base),
    [{ chatId: 'alice@im.wechat' }],
    ['alice@im.wechat'],
    `${peer.base}/dispatch`,
    { filename: first.filename }
  )

  await nextPlugin.start?.(new AbortController().signal)
  await waitFor(() => cursors.length >= 3)
  await nextPlugin.stop?.()
  expect(cursors.slice(0, 3)).toEqual(['', 'cursor-next', 'cursor-next'])
  expect(await next.storage.listInbound({ limit: 10 })).toHaveLength(1)
  expect(
    (await next.storage.listInbound({ limit: 10 }))[0]?.snapshot.source.eventId
  ).toBe('18446744073709551615')

  const target = await nextPlugin.resolveChannel?.({
    id: 'channel',
    platform: 'wechat',
    accountId: 'bot',
    chatId: 'alice@im.wechat'
  })

  expect(target?.status).toBe('available')
  if (target?.status !== 'available') {
    throw new Error('missing_target')
  }
  expect(
    await nextPlugin.send({ ...input(peer.base), target: target.target })
  ).toMatchObject({ status: 'sent' })
  expect(sendBodies).toEqual([
    {
      msg: {
        from_user_id: '',
        to_user_id: 'alice@im.wechat',
        client_id: 'delivery:0',
        message_type: 2,
        message_state: 2,
        context_token: 'context',
        item_list: [{ type: 1, text_item: { text: 'answer' } }]
      },
      base_info: { channel_version: '0.1.0', bot_agent: 'Relanox/0.1.0' }
    }
  ])
})

it.each([
  [{}, 'unknown'],
  [{ ret: -14 }, 'rejected'],
  [{ ret: 0 }, 'sent']
] as const)('classifies send outcome %j as %s', async (result, status) => {
  const peer = await httpPeer((_request, response) => {
    if (!('ret' in result)) {
      response.destroy()
      return
    }
    json(response, result)
  })

  const plugin = createWechatChannel({ WECHAT_TOKEN: 'token' })
  await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'alice@im.wechat' }],
    ['alice@im.wechat'],
    `${peer.base}/dispatch`
  )
  expect((await plugin.send(input(peer.base))).status).toBe(status)
})

it('encrypts uploaded files and preserves native file length and CDN media references', async () => {
  let key = ''
  let uploaded = Buffer.alloc(0)
  let sent: unknown

  const peer = await httpPeer(async (request, response) => {
    if (request.url?.startsWith('/c2c/upload')) {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk as Uint8Array))
      }
      uploaded = Buffer.concat(chunks)
      response.writeHead(200, { 'x-encrypted-param': 'download-ticket' })
      response.end()
      return
    }
    const raw = await body(request)
    if (request.url?.endsWith('getuploadurl')) {
      const value = z
        .object({
          aeskey: z.string(),
          media_type: z.number(),
          rawsize: z.number(),
          filesize: z.number(),
          rawfilemd5: z.string()
        })
        .parse(raw)

      key = value.aeskey
      expect(value).toMatchObject({
        media_type: 3,
        rawsize: 3,
        filesize: 16,
        rawfilemd5: '900150983cd24fb0d6963f7d28e17f72'
      })
      json(response, { upload_param: 'upload-ticket' })
      return
    }
    sent = raw
    json(response, { ret: 0 })
  })

  const plugin = createWechatChannel({ WECHAT_TOKEN: 'token' })
  await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'alice@im.wechat' }],
    ['alice@im.wechat'],
    `${peer.base}/dispatch`
  )
  const send = input(peer.base)

  const reference = {
    id: 'media',
    kind: 'file' as const,
    mimeType: 'text/plain',
    fileName: 'hello.txt',
    size: 3,
    sha256: 'fixture'
  }

  expect(
    await plugin.send({
      ...send,
      chunk: { ...send.chunk, text: '', media: reference },
      media: { reference, data: Buffer.from('abc') }
    })
  ).toMatchObject({ status: 'sent' })

  const decipher = createDecipheriv(
    'aes-128-ecb',
    Buffer.from(key, 'hex'),
    null
  )

  expect(
    Buffer.concat([decipher.update(uploaded), decipher.final()]).toString()
  ).toBe('abc')
  expect(sent).toMatchObject({
    msg: {
      item_list: [
        {
          type: 4,
          file_item: {
            file_name: 'hello.txt',
            len: '3',
            media: {
              encrypt_query_param: 'download-ticket',
              aes_key: Buffer.from(key).toString('base64'),
              encrypt_type: 1
            }
          }
        }
      ]
    }
  })
})

it('decrypts incoming file media using base64-encoded raw keys and retains opaque filenames', async () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const encrypted = Buffer.concat([cipher.update('abc'), cipher.final()])
  let polls = 0

  const peer = await httpPeer((_request, response) => {
    if (_request.url?.startsWith('/c2c/download')) {
      response.end(encrypted)
      return
    }
    polls += 1
    if (polls > 1) {
      return
    }
    json(response, {
      ret: 0,
      get_updates_buf: 'media-cursor',
      msgs: [
        {
          message_id: 9,
          from_user_id: 'alice@im.wechat',
          message_type: 1,
          context_token: 'context',
          item_list: [
            {
              type: 4,
              file_item: {
                file_name: 'native.txt',
                len: '3',
                media: {
                  encrypt_query_param: 'download',
                  aes_key: key.toString('base64'),
                  encrypt_type: 1
                }
              }
            }
          ]
        }
      ]
    })
  })

  const plugin = createWechatChannel({ WECHAT_TOKEN: 'token' })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'alice@im.wechat' }],
    ['alice@im.wechat'],
    `${peer.base}/dispatch`
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () => (await fixture.storage.listInbound({ limit: 10 })).length === 1
  )
  await plugin.stop?.()
  const record = (await fixture.storage.listInbound({ limit: 10 }))[0]
  const attachment = record?.snapshot.attachments?.[0]
  expect(attachment).toMatchObject({
    fileName: 'native.txt',
    size: 3,
    kind: 'file'
  })
  if (!record || !attachment) {
    throw new Error('missing_attachment')
  }
  expect(
    (
      await fixture.storage.media?.get(
        record.snapshot.channel.id,
        attachment.id
      )
    )?.data
  ).toEqual(new Uint8Array([97, 98, 99]))
})
