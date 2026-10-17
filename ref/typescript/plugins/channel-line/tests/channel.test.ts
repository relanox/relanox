import type { CoreRuntime } from '../../../packages/core/src/index.js'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Json,
  SendInput,
  Storage,
  InboundSnapshot,
  OutboundRecord
} from '@relanox/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createLineChannel } from '../src/index.js'
import { harness, peer } from './harness.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

const config = (): Json => ({
  channelSecret: { env: 'LINE_SECRET' },
  accessToken: { env: 'LINE_TOKEN' }
})

function webhook(text = 'hello', destination = 'bot', sender = 'user'): string {
  return JSON.stringify({
    destination,
    events: [
      {
        type: 'message',
        webhookEventId: 'event-1',
        timestamp: 1,
        source: { type: 'group', groupId: 'group', userId: sender },
        message: { id: 'message-1', type: 'text', text },
        replyToken: 'expired-token'
      }
    ]
  })
}

function incoming(body: string, signature?: string): Request {
  const expected = createHmac('sha256', 'secret').update(body).digest('base64')
  return new Request('http://local/channels/business/webhook', {
    method: 'POST',
    headers: { 'x-line-signature': signature ?? expected },
    body
  })
}

async function setup(filename?: string): Promise<{
  core: CoreRuntime
  storage: Storage
  dispatches: string[]
  sendReply(
    this: void,
    text?: string
  ): Promise<{
    request: InboundSnapshot
    delivery: OutboundRecord | undefined
  }>
  close(this: void): Promise<void>
  remote: Awaited<ReturnType<typeof peer>>
  plugin: ReturnType<typeof createLineChannel>
}> {
  vi.stubEnv('LINE_SECRET', 'secret')
  vi.stubEnv('LINE_TOKEN', 'token')
  const remote = await peer()
  cleanup.push(remote.close)
  remote.respond(200, { sentMessages: [{ id: 'sent-1' }] })
  const plugin = createLineChannel()

  const local = await harness(
    plugin,
    config(),
    'group',
    'user',
    undefined,
    filename
  )

  cleanup.push(local.close)
  return { remote, plugin, ...local }
}

describe('native LINE', () => {
  it.each(['labeled', 'long'] as const)(
    'preserves %s link destinations in bounded native quote text',
    async (kind) => {
      // Native quoted text uses the LINE text message contract, including its
      // 5,000 UTF-16-unit limit; Flex URI actions cannot accompany quoteToken.
      // https://developers.line.biz/en/reference/messaging-api/#text-message
      vi.stubEnv('LINE_SECRET', 'secret')
      vi.stubEnv('LINE_TOKEN', 'token')
      const remote = await peer()
      cleanup.push(remote.close)
      remote.respond(200, { sentMessages: [{ id: 'sent' }] })

      const local = await harness(
        createLineChannel(),
        config(),
        'group',
        'user'
      )

      cleanup.push(local.close)

      const body = JSON.stringify({
        destination: 'bot',
        events: [
          {
            type: 'message',
            webhookEventId: 'link-event',
            source: { type: 'group', groupId: 'group', userId: 'user' },
            message: {
              id: 'link-message',
              type: 'text',
              text: 'share the links',
              quoteToken: 'link-quote'
            }
          }
        ]
      })

      expect((await local.core.fetch(incoming(body))).status).toBe(200)

      const request = (await local.storage.listInbound({ limit: 10 }))[0]
        ?.snapshot

      if (!request) {
        throw new Error('missing_request')
      }
      const longUrl = `https://example.com/${'x'.repeat(850)}`

      const markdown =
        kind === 'labeled'
          ? '[**download** file](https://example.com/file.zip) and [https://example.com/file.zip](https://example.com/file.zip)'
          : [1, 2, 3, 4, 5, 6]
              .map((number) => `[file ${number}](${longUrl})`)
              .join(' ')

      const expected =
        kind === 'labeled'
          ? 'download file (https://example.com/file.zip) and https://example.com/file.zip'
          : [1, 2, 3, 4, 5, 6]
              .map((number) => `file ${number} (${longUrl})`)
              .join(' ')

      expect(
        await local.principal().sendMessage({
          channel: request.channel.id,
          text: markdown,
          reply: { requestId: request.requestId, kind: 'final' }
        })
      ).toMatchObject({ status: 'queued' })
      await local.core.processDue()

      const texts = remote.traffic.flatMap((item) =>
        z
          .object({
            to: z.literal('group'),
            messages: z.array(
              z.object({
                type: z.literal('text'),
                text: z.string().max(5000),
                quoteToken: z.literal('link-quote')
              })
            )
          })
          .parse(JSON.parse(item.body))
          .messages.map((message) => message.text)
      )

      expect(texts.join('').replaceAll(/\s/gu, '')).toBe(
        expected.replaceAll(/\s/gu, '')
      )
      if (kind === 'long') {
        expect(texts.length).toBeGreaterThan(1)
      }
    }
  )

  it('quotes the selected native token for out-of-order requests and omits it for ordinary sends', async () => {
    // Quote token is distinct from message ID and scoped to the original chat:
    // https://developers.line.biz/en/docs/messaging-api/get-quote-tokens/
    // Only text/textV2/sticker accept it:
    // https://developers.line.biz/en/docs/messaging-api/sending-messages/#send-quote-messages
    vi.stubEnv('LINE_SECRET', 'secret')
    vi.stubEnv('LINE_TOKEN', 'token')
    const remote = await peer()
    cleanup.push(remote.close)
    remote.respond(200, { sentMessages: [{ id: 'sent' }] })
    const local = await harness(createLineChannel(), config(), 'group', 'user')
    cleanup.push(local.close)
    for (const number of [4, 1, 2, 3]) {
      const body = JSON.stringify({
        destination: 'bot',
        events: [
          {
            type: 'message',
            webhookEventId: `event-${number}`,
            source: { type: 'group', groupId: 'group', userId: 'user' },
            message: {
              id: `message-${number}`,
              type: 'text',
              text: `question ${number}`,
              ...(number === 4 ? {} : { quoteToken: `native-token-${number}` })
            }
          }
        ]
      })

      expect((await local.core.fetch(incoming(body))).status).toBe(200)
    }
    const requests = await local.storage.listInbound({ limit: 10 })
    const principal = local.principal()
    const channel = requests[0]?.snapshot.channel.id
    if (!channel) {
      throw new Error('missing_channel')
    }
    for (const number of [2, 1, 3, 4]) {
      const selected = requests.find(
        (item) => item.snapshot.target.replyToId === `message-${number}`
      )

      if (!selected) {
        throw new Error('missing_request')
      }
      expect(
        await principal.sendMessage({
          channel,
          text: `answer ${number}`,
          idempotencyKey: `reply-${number}`,
          reply: { requestId: selected.snapshot.requestId, kind: 'final' }
        })
      ).toMatchObject({ status: 'queued' })
      await local.core.processDue()
    }
    expect(
      await principal.sendMessage({
        channel,
        text: 'ordinary',
        idempotencyKey: 'ordinary'
      })
    ).toMatchObject({ status: 'queued' })
    await local.core.processDue()
    expect(
      remote.traffic.slice(0, 3).map((item) => JSON.parse(item.body) as unknown)
    ).toEqual([
      {
        to: 'group',
        messages: [
          { type: 'text', text: 'answer 2', quoteToken: 'native-token-2' }
        ]
      },
      {
        to: 'group',
        messages: [
          { type: 'text', text: 'answer 1', quoteToken: 'native-token-1' }
        ]
      },
      {
        to: 'group',
        messages: [
          { type: 'text', text: 'answer 3', quoteToken: 'native-token-3' }
        ]
      }
    ])
    expect(remote.traffic).toHaveLength(5)
    expect(remote.traffic[3]?.body).not.toContain('quoteToken')
    expect(remote.traffic[4]?.body).not.toContain('quoteToken')
  })

  it('checks signed native sender authorization before media HTTP and preserves SQLite failures', async () => {
    const local = await setup()

    // Official webhook source identity and authenticated binary content contracts:
    // Line/line-bot-sdk-nodejs@deac3147609c73fe0ff0746fe231ab5bfdbd06c0
    // Lib/webhook/model/groupSource.ts and lib/webhook/model/videoMessageContent.ts.
    // Transport bytes: examples/kitchensink/static/imagemap/video.mp4, first 28 bytes.
    const video = Buffer.from(
      '0000001c667479706d703432000000016d7034316d70343269736f6d',
      'hex'
    )

    local.remote.content({ status: 200, data: video, mimeType: 'video/mp4' })

    const body = (sender: string, eventId: string): string =>
      JSON.stringify({
        destination: 'bot',
        events: [
          {
            type: 'message',
            webhookEventId: eventId,
            source: { type: 'group', groupId: 'group', userId: sender },
            message: {
              id: 'policy-video-message',
              type: 'video',
              contentProvider: { type: 'line' }
            }
          }
        ]
      })

    const authorized = body('user', 'allowed-video')
    expect(
      (await local.core.fetch(incoming(authorized, 'invalid'))).status
    ).toBe(401)
    expect(local.remote.traffic).toHaveLength(0)
    expect(
      (await local.core.fetch(incoming(body('denied-user', 'denied-video'))))
        .status
    ).toBe(200)
    expect(local.remote.traffic).toHaveLength(0)
    expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
    expect((await local.core.fetch(incoming(authorized))).status).toBe(200)
    expect(local.remote.traffic).toHaveLength(1)
    expect(local.remote.traffic[0]).toMatchObject({
      path: '/v2/bot/message/policy-video-message/content',
      headers: { authorization: 'Bearer token' }
    })
    const records = await local.storage.listInbound({ limit: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]?.snapshot).toMatchObject({
      senderId: 'user',
      attachments: [{ kind: 'video', mimeType: 'video/mp4', size: 28 }]
    })
    await local.close()
    cleanup.pop()
    expect(
      (await local.core.fetch(incoming(body('user', 'storage-failure-video'))))
        .status
    ).toBe(500)
    expect(local.remote.traffic).toHaveLength(2)
  })

  it('waits for native video preparation before acknowledging and storing the binary content', async () => {
    const local = await setup()

    // LINE Get content returns 202 during preparation, then 200 binary:
    // https://developers.line.biz/en/reference/messaging-api/#get-content
    // Fixed transport bytes: official SDK deac3147609c73fe0ff0746fe231ab5bfdbd06c0,
    // Examples/kitchensink/static/imagemap/video.mp4, first 28-byte ftyp box.
    const video = Buffer.from(
      '0000001c667479706d703432000000016d7034316d70343269736f6d',
      'hex'
    )

    local.remote.content(
      {
        status: 202,
        data: new Uint8Array(),
        mimeType: 'application/octet-stream'
      },
      { status: 200, data: video, mimeType: 'video/mp4' }
    )

    const body = JSON.stringify({
      destination: 'bot',
      events: [
        {
          type: 'message',
          webhookEventId: 'ready-video-event',
          source: { type: 'group', groupId: 'group', userId: 'user' },
          message: {
            id: 'ready-video-message',
            type: 'video',
            contentProvider: { type: 'line' }
          }
        }
      ]
    })

    expect((await local.core.fetch(incoming(body))).status).toBe(200)
    const records = await local.storage.listInbound({ limit: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]?.snapshot.attachments).toMatchObject([
      { kind: 'video', mimeType: 'video/mp4', size: 28 }
    ])
    expect(local.remote.traffic).toHaveLength(2)
    await local.core.processDue()
    expect(local.dispatches).toEqual([''])
  })

  it('withholds ACK for preparing video content and recovers its redelivery after SQLite restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relanox-line-content-'))
    cleanup.push(async () => {
      await rm(directory, { recursive: true })
    })
    const filename = join(directory, 'state.db')
    const local = await setup(filename)

    // Get content documents 202 while video/audio is preparing, and 200 binary:
    // https://developers.line.biz/en/reference/messaging-api/#get-content
    const body = JSON.stringify({
      destination: 'bot',
      events: [
        {
          type: 'message',
          webhookEventId: 'video-event',
          timestamp: 1,
          source: { type: 'group', groupId: 'group', userId: 'user' },
          message: {
            id: 'video-message',
            type: 'video',
            contentProvider: { type: 'line' }
          }
        }
      ]
    })

    local.remote.content({
      status: 202,
      data: new Uint8Array(),
      mimeType: 'application/octet-stream'
    })
    expect((await local.core.fetch(incoming(body))).status).toBe(500)
    expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
    expect(local.dispatches).toEqual([])
    expect(local.remote.traffic).toHaveLength(3)
    await local.close()
    cleanup.pop()

    const restarted = await harness(
      createLineChannel(),
      config(),
      'group',
      'user',
      undefined,
      filename
    )

    cleanup.push(restarted.close)

    // Fixed ftyp box from the official SDK's sample video (transport bytes only):
    // Line/line-bot-sdk-nodejs@deac3147609c73fe0ff0746fe231ab5bfdbd06c0
    // Examples/kitchensink/static/imagemap/video.mp4, first 28 bytes.
    const video = Buffer.from(
      '0000001c667479706d703432000000016d7034316d70343269736f6d',
      'hex'
    )

    local.remote.content({ status: 200, data: video, mimeType: 'video/mp4' })
    expect((await restarted.core.fetch(incoming(body))).status).toBe(200)
    const records = await restarted.storage.listInbound({ limit: 10 })
    expect(records).toHaveLength(1)
    const snapshot = records[0]?.snapshot
    const attachment = snapshot?.attachments?.[0]
    expect(attachment).toMatchObject({
      kind: 'video',
      mimeType: 'video/mp4',
      size: 28
    })
    if (!snapshot || !attachment) {
      throw new Error('missing_video_attachment')
    }

    const stored = await restarted.storage.media?.get(
      snapshot.channel.id,
      attachment.id
    )

    expect(Buffer.from(stored?.data ?? [])).toEqual(video)
    expect(local.remote.traffic).toHaveLength(4)
    expect(local.remote.traffic[0]).toMatchObject({
      path: '/v2/bot/message/video-message/content',
      headers: { authorization: 'Bearer token' }
    })
    await restarted.core.processDue()
    expect(restarted.dispatches).toEqual([''])
  })

  it.each(['group', 'room'] as const)(
    'acknowledges %s messages without a sender while persisting subsequent authorized events',
    async (type) => {
      const local = await setup()

      // LINE explicitly makes group/room userId optional:
      // https://developers.line.biz/en/reference/messaging-api/#source-group
      // https://developers.line.biz/en/reference/messaging-api/#source-room
      const body = JSON.stringify({
        destination: 'bot',
        events: [
          {
            type: 'message',
            webhookEventId: 'anonymous-event',
            timestamp: 1,
            source: { type, [`${type}Id`]: 'group' },
            message: { id: 'anonymous-image', type: 'image' }
          },
          {
            type: 'message',
            webhookEventId: 'authorized-event',
            timestamp: 2,
            source: { type, [`${type}Id`]: 'group', userId: 'user' },
            message: { id: 'authorized-message', type: 'text', text: 'hello' }
          }
        ]
      })

      expect((await local.core.fetch(incoming(body))).status).toBe(200)
      expect((await local.core.fetch(incoming(body))).status).toBe(200)
      const records = await local.storage.listInbound({ limit: 10 })
      expect(records).toHaveLength(1)
      expect(records[0]?.snapshot).toMatchObject({
        source: { eventId: 'authorized-event' },
        senderId: 'user',
        text: 'hello'
      })
      expect(local.remote.traffic).toHaveLength(0)
      await local.core.processDue()
      expect(local.dispatches).toEqual(['hello'])
    }
  )

  it('discovers bot identity with the account token before accepting signed webhooks', async () => {
    const local = await setup()
    expect(local.remote.identities).toHaveLength(1)
    expect(local.remote.identities[0]).toMatchObject({
      path: '/v2/bot/info',
      headers: { authorization: 'Bearer token' }
    })
    expect(
      (await local.core.fetch(incoming(webhook('hello', 'other-bot')))).status
    ).toBe(403)
    expect((await local.storage.getStats()).pending).toBe(0)
    expect((await local.core.fetch(incoming(webhook()))).status).toBe(200)
    expect((await local.storage.getStats()).pending).toBe(1)
  })

  it.each([401, 200])(
    'fails setup safely when bot info returns %s without an identity, and permits a corrected retry',
    async (status) => {
      vi.stubEnv('LINE_SECRET', 'secret')
      vi.stubEnv('LINE_TOKEN', 'token')
      const remote = await peer()
      cleanup.push(remote.close)
      remote.identityResponse(status, {})
      const plugin = createLineChannel()
      await expect(harness(plugin, config(), 'group', 'user')).rejects.toThrow()
      expect(
        await plugin.send({
          deliveryId: 'delivery',
          channelId: 'request',
          target: {
            channel: 'line',
            accountId: 'business',
            chatId: 'group',
            data: {
              destination: 'group',
              sourceType: 'group',
              botId: 'bot',
              apiBaseUrl: remote.base
            }
          },
          chunk: { text: 'answer', idempotencyKey: 'delivery:0', state: null },
          chunkIndex: 0,
          signal: new AbortController().signal
        })
      ).toEqual({ status: 'rejected', errorCode: 'invalid_target' })
      expect(remote.traffic).toHaveLength(0)
      remote.identity('bot')
      const local = await harness(plugin, config(), 'group', 'user')
      cleanup.push(local.close)
      expect((await local.core.fetch(incoming(webhook()))).status).toBe(200)
      expect((await local.storage.getStats()).pending).toBe(1)
    }
  )

  it.each(['identity', 'server', 'legacy'])(
    'refuses a persisted target after %s changes',
    async (change) => {
      const local = await setup()
      await local.core.fetch(incoming(webhook()))
      const completed = await local.sendReply()
      const outbound = completed.delivery
      if (!outbound?.chunks[0]) {
        throw new Error('Missing stored outbound')
      }
      local.remote.identity(change === 'identity' ? 'other-bot' : 'bot')
      const changedPlugin = createLineChannel()
      const changed = await harness(changedPlugin, config(), 'group', 'user')
      cleanup.push(changed.close)
      let target = outbound.target
      if (change === 'legacy') {
        target = {
          ...target,
          data: { destination: 'group', sourceType: 'group' }
        }
      } else if (change === 'server') {
        target = {
          ...target,
          data: {
            ...z.record(z.string(), z.json()).parse(target.data),
            apiBaseUrl: 'https://other.example'
          }
        }
      }
      expect(
        await changedPlugin.send({
          deliveryId: outbound.deliveryId,
          channelId: outbound.channelId,
          target,
          chunk: outbound.chunks[0],
          chunkIndex: 0,
          signal: new AbortController().signal
        })
      ).toEqual({ status: 'rejected', errorCode: 'invalid_target' })
      expect(local.remote.traffic).toHaveLength(1)
    }
  )

  it('keeps credential rotation on the same canonical API endpoint deliverable', async () => {
    const local = await setup()
    await local.core.fetch(incoming(webhook()))
    const completed = await local.sendReply()
    const outbound = completed.delivery
    if (!outbound?.chunks[0]) {
      throw new Error('Missing stored outbound')
    }
    vi.stubEnv('LINE_TOKEN', 'rotated-token')
    const restartedPlugin = createLineChannel()

    const restarted = await harness(restartedPlugin, config(), 'group', 'user')

    cleanup.push(restarted.close)
    expect(
      (
        await restartedPlugin.send({
          deliveryId: outbound.deliveryId,
          channelId: outbound.channelId,
          target: outbound.target,
          chunk: outbound.chunks[0],
          chunkIndex: 0,
          signal: new AbortController().signal
        })
      ).status
    ).toBe('sent')
    expect(local.remote.traffic[1]).toMatchObject({
      path: '/v2/bot/message/push',
      headers: { authorization: 'Bearer rotated-token' }
    })
  })

  it('authenticates exact bytes, deduplicates durably and independently pushes the frozen group', async () => {
    const local = await setup()
    expect((await local.core.fetch(incoming(webhook(), 'bad'))).status).toBe(
      401
    )
    expect((await local.core.fetch(incoming('{'))).status).toBe(400)
    expect(
      (await local.core.fetch(incoming(webhook('hello', 'other-bot')))).status
    ).toBe(403)
    expect((await local.core.fetch(incoming(`${webhook()}\n`))).status).toBe(
      200
    )
    expect((await local.core.fetch(incoming(webhook()))).status).toBe(200)
    expect((await local.storage.getStats()).pending).toBe(1)

    const completed = await local.sendReply(
      '**bold** _ital_ ~~gone~~ [site](https://example.com) `x*y`'
    )

    expect(local.dispatches).toEqual(['hello'])
    expect(completed.delivery?.status).toBe('sent')
    expect(completed.request.target).toEqual({
      channel: 'line',
      accountId: 'business',
      chatId: 'group',
      replyToId: 'message-1',
      data: {
        destination: 'group',
        sourceType: 'group',
        botId: 'bot',
        apiBaseUrl: local.remote.base
      }
    })
    const sent = local.remote.traffic[0]
    expect(sent?.path).toBe('/v2/bot/message/push')
    expect(sent?.headers.authorization).toBe('Bearer token')
    expect(JSON.parse(sent?.body ?? 'null') as unknown).toEqual({
      to: 'group',
      messages: [
        {
          type: 'flex',
          altText: 'bold ital gone site x*y',
          contents: {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  wrap: true,
                  contents: [
                    { type: 'span', text: 'bold', weight: 'bold' },
                    { type: 'span', text: ' ' },
                    { type: 'span', text: 'ital', style: 'italic' },
                    { type: 'span', text: ' ' },
                    { type: 'span', text: 'gone', decoration: 'line-through' },
                    { type: 'span', text: ' ' }
                  ]
                },
                {
                  type: 'text',
                  wrap: true,
                  contents: [{ type: 'span', text: 'site' }],
                  action: { type: 'uri', uri: 'https://example.com/' }
                },
                {
                  type: 'text',
                  wrap: true,
                  contents: [
                    { type: 'span', text: ' ' },
                    { type: 'span', text: 'x*y' }
                  ]
                }
              ]
            }
          }
        }
      ]
    })
    expect(sent?.headers['x-line-retry-key']).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('splits styled Flex contents by serialized bytes and bounds notification previews', async () => {
    const local = await setup()
    await local.core.fetch(incoming(webhook()))
    const completed = await local.sendReply('**😀** '.repeat(700))
    expect(completed.delivery?.status).toBe('sent')

    const payloads = local.remote.traffic.map((item) =>
      z
        .object({
          messages: z.array(
            z.object({
              type: z.literal('flex'),
              altText: z.string(),
              contents: z.object({
                body: z.object({
                  contents: z.array(
                    z.object({
                      contents: z.array(
                        z.object({
                          text: z.string(),
                          weight: z.string().optional()
                        })
                      )
                    })
                  )
                })
              })
            })
          )
        })
        .parse(JSON.parse(item.body))
    )

    expect(payloads.length).toBeGreaterThan(1)
    const texts: string[] = []
    for (const payload of payloads) {
      const message = payload.messages[0]
      if (!message) {
        throw new Error('missing_flex')
      }
      expect(
        Buffer.byteLength(JSON.stringify(message.contents), 'utf8')
      ).toBeLessThanOrEqual(30_000)
      expect(message.altText.length).toBeLessThanOrEqual(1500)
      expect(message.altText.isWellFormed()).toBe(true)
      for (const component of message.contents.body.contents) {
        for (const run of component.contents) {
          texts.push(run.text)
          if (run.text.includes('😀')) {
            expect(run.weight).toBe('bold')
          }
        }
      }
    }
    expect(texts.join('').replaceAll(/\s/gu, '')).toBe('😀'.repeat(700))
  })

  it('reuses a persisted push retry UUID across a SQLite close/reopen and accepts 409 receipts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relanox-line-'))
    cleanup.push(async () => {
      await rm(directory, { recursive: true })
    })
    const local = await setup(join(directory, 'state.db'))
    await local.core.fetch(incoming(webhook()))
    local.remote.respond(429, {}, { 'retry-after': '2' })
    const completed = await local.sendReply()
    const outbound = completed.delivery
    if (!outbound?.chunks[0]) {
      throw new Error('No outbound chunk')
    }

    const send: SendInput = {
      deliveryId: outbound.deliveryId,
      channelId: outbound.channelId,
      target: outbound.target,
      chunk: outbound.chunks[0],
      chunkIndex: 0,
      signal: new AbortController().signal
    }

    const retryKey = local.remote.traffic[0]?.headers['x-line-retry-key']
    await local.close()
    cleanup.pop()
    const restartedPlugin = createLineChannel()

    const restarted = await harness(
      restartedPlugin,
      config(),
      'group',
      'user',
      undefined,
      join(directory, 'state.db')
    )

    cleanup.push(restarted.close)
    local.remote.respond(
      409,
      {},
      { 'x-line-accepted-request-id': 'accepted-1' }
    )
    expect(await restartedPlugin.send(send)).toEqual({
      status: 'sent',
      receipt: { data: { acceptedRequestId: 'accepted-1' } }
    })
    expect(local.remote.traffic[1]?.headers['x-line-retry-key']).toBe(retryKey)
    const key = `push:${send.chunk.idempotencyKey}`
    const namespace = { pluginId: 'channel-line', ownerId: 'business' }
    const saved = await restarted.storage.getState(namespace, key)
    if (!saved) {
      throw new Error('Missing persisted retry identity')
    }
    const value = z.object({ retryKey: z.string() }).parse(saved.value)
    await restarted.storage.compareAndSetState(namespace, {
      key,
      expectedVersion: saved.version,
      value: { retryKey: value.retryKey, startedAt: Date.now() - 86_400_001 }
    })
    expect(await restartedPlugin.send(send)).toEqual({
      status: 'unknown',
      errorCode: 'retry_key_expired'
    })
    expect(local.remote.traffic).toHaveLength(2)
  })

  it.each([
    [429, 'retryable'],
    [403, 'rejected'],
    [503, 'unknown']
  ] as const)(
    'classifies HTTP %s without blind retries',
    async (status, expected) => {
      const local = await setup()
      await local.core.fetch(incoming(webhook()))
      local.remote.respond(status, {}, { 'retry-after': '2' })
      const completed = await local.sendReply()
      expect(completed.delivery?.status).toBe(
        expected === 'retryable' ? 'pending' : expected
      )
      if (expected === 'retryable') {
        expect(completed.delivery?.dueAt).toBeGreaterThan(Date.now() + 1000)
      }
      expect(local.remote.traffic).toHaveLength(1)
    }
  )

  it('ACKs only known policy exclusions and does not ACK real SQLite failures', async () => {
    const local = await setup()
    expect(
      (await local.core.fetch(incoming(webhook('hello', 'bot', 'denied-user'))))
        .status
    ).toBe(200)
    expect((await local.storage.getStats()).pending).toBe(0)
    await local.close()
    cleanup.pop()
    expect((await local.core.fetch(incoming(webhook()))).status).toBe(500)
  })

  it('rejects plain credentials and unauthorized HTTP endpoints', () => {
    const plugin = createLineChannel()
    expect(() =>
      plugin.validateConfig({
        channelSecret: 'secret',
        accessToken: 'token'
      })
    ).toThrow()
    expect(() =>
      plugin.validateConfig({
        channelSecret: { env: 'SECRET' },
        accessToken: { env: 'TOKEN' },
        apiBase: 'http://127.0.0.1:4000'
      })
    ).toThrow()
    expect(plugin.capabilities.idempotentSend).toBe(false)
  })
})
