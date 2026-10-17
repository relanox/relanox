import { afterEach, expect, it, vi } from 'vitest'
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

// Protect the actual Core rich plan above the former 10MB/MIME descriptor.
// Existing direct-send layouts use tiny PNGs and miss Core's standalone fallback.
// Real SQLite and the official SDK contact a real HTTP peer; no production seam.
// The generated SDK's FlexImage accepts URL metadata; bytes are opaque test data,
// And peer acceptance does not establish live-account AVIF support.
// https://developers.line.biz/en/reference/messaging-api/#flex-message
it('keeps a budgeted large image in Core Flex layout and delegates acceptance to the SDK', async () => {
  vi.stubEnv('LINE_TOKEN', 'token')
  const remote = await peer()
  cleanup.push(remote.close)
  remote.respond(200, { sentMessages: [{ id: 'sent' }] })

  const local = await harness(
    createLineChannel(),
    {
      channelSecret: { env: 'LINE_TOKEN' },
      accessToken: { env: 'LINE_TOKEN' }
    },
    'group',
    'user'
  )

  cleanup.push(local.close)
  const principal = local.principal()
  const channel = (await principal.status()).channels[0]?.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }

  const queued = await principal.sendMessage({
    channel,
    text: `${'a'.repeat(2001)}\n![photo](relanox://attachment/1)\nafter`,
    attachments: [
      {
        kind: 'image',
        mimeType: 'image/avif',
        fileName: 'large.avif',
        data: new Uint8Array(10_000_001)
      }
    ]
  })

  expect(queued.status).toBe('queued')
  if (queued.status !== 'queued') {
    throw new Error('missing_delivery')
  }
  const plan = await local.storage.getOutbound(queued.deliveryId)
  expect(plan?.chunks).toHaveLength(2)
  expect(plan?.chunks[1]?.richText?.map((part) => part.type)).toEqual([
    'text',
    'image',
    'text'
  ])
  await local.core.processDue()
  await local.core.processDue()
  expect((await local.storage.getOutbound(queued.deliveryId))?.status).toBe(
    'sent'
  )
  expect(remote.traffic).toHaveLength(2)
  expect(JSON.parse(remote.traffic[1]?.body ?? '{}')).toMatchObject({
    to: 'group',
    messages: [
      {
        type: 'flex',
        contents: {
          type: 'bubble',
          body: {
            contents: [
              { type: 'text' },
              { type: 'image', size: 'full' },
              { type: 'text' }
            ]
          }
        }
      }
    ]
  })
})

// Ordinary image/audio payloads carry URLs and audio duration; the SDK models
// Do not impose local MIME or preview-size preflights. Such old preflights stop
// These queued sends before HTTP; existing Flex coverage misses ordinary media.
// Real SQLite, HTTP and SDK are used without a production testing interface.
// @line/bot-sdk 11.3.0 lib/messaging-api/model/{imageMessage,audioMessage}.ts.
it.each(['image', 'audio'] as const)(
  'delegates ordinary %s formats using the native URL fields',
  async (kind) => {
    vi.stubEnv('LINE_TOKEN', 'token')
    const remote = await peer()
    cleanup.push(remote.close)
    remote.respond(200, { sentMessages: [{ id: 'sent' }] })

    const local = await harness(
      createLineChannel(),
      {
        channelSecret: { env: 'LINE_TOKEN' },
        accessToken: { env: 'LINE_TOKEN' }
      },
      'group',
      'user'
    )

    cleanup.push(local.close)
    const principal = local.principal()
    const channel = (await principal.status()).channels[0]?.channel.id
    if (!channel) {
      throw new Error('missing_channel')
    }

    const queued = await principal.sendMessage({
      channel,
      text: '',
      attachments: [
        {
          kind,
          mimeType: kind === 'image' ? 'image/webp' : 'audio/ogg',
          fileName: kind === 'image' ? 'photo.webp' : 'voice.ogg',
          data: new Uint8Array(kind === 'image' ? 1_000_001 : 5),
          ...(kind === 'audio' ? { durationMs: 1234 } : {})
        }
      ]
    })

    expect(queued.status).toBe('queued')
    if (queued.status !== 'queued') {
      throw new Error('missing_delivery')
    }
    await local.core.processDue()
    expect((await local.storage.getOutbound(queued.deliveryId))?.status).toBe(
      'sent'
    )
    expect(remote.traffic).toHaveLength(1)

    const native = z
      .object({
        to: z.string(),
        messages: z.array(
          z.object({
            type: z.string(),
            originalContentUrl: z.string(),
            previewImageUrl: z.string().optional(),
            duration: z.number().optional()
          })
        )
      })
      .parse(JSON.parse(remote.traffic[0]?.body ?? '{}'))

    expect(native.to).toBe('group')
    expect(native.messages).toHaveLength(1)
    expect(native.messages[0]?.type).toBe(kind)
    expect(native.messages[0]?.originalContentUrl).toMatch(
      /^https:\/\/relay\.example\/media\//u
    )
    if (kind === 'audio') {
      expect(native.messages[0]?.duration).toBe(1234)
    } else {
      expect(native.messages[0]?.previewImageUrl).toMatch(
        /^https:\/\/relay\.example\/media\//u
      )
    }
  }
)
