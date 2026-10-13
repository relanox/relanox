import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { noopObservability } from '@relanox/sdk'
import type { WorkerOptions } from '@relanox/core'
import {
  closeServer,
  createListeners,
  listen
} from '../../../apps/cli/src/listeners.js'
import { createLineChannel } from '../src/index.js'
import { harness, peer } from './harness.js'

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

const config = {
  channelSecret: { env: 'LINE_SECRET' },
  accessToken: { env: 'LINE_TOKEN' }
}

const botId = 'U11111111111111111111111111111111'
const userId = 'U22222222222222222222222222222222'
const groupId = 'C33333333333333333333333333333333'
const mediaEventId = '01H810YECXQQZ37VAXPF6H9E6T'
const textEventId = '01H810YECXQQZ37VAXPF6H9E6V'
const messageId = '468789577898262530'

// Native message shapes: Line/line-bot-sdk-nodejs@deac3147609c73fe0ff0746fe231ab5bfdbd06c0,
// Lib/webhook/model/{fileMessageContent,videoMessageContent,groupSource}.ts.
// Binary transport fixture: examples/kitchensink/static/imagemap/video.mp4, first ftyp box.
const video = Buffer.from(
  '0000001c667479706d703432000000016d7034316d70343269736f6d',
  'hex'
)

function batch(declaredFile = false): string {
  return JSON.stringify({
    destination: botId,
    events: [
      {
        type: 'message',
        webhookEventId: mediaEventId,
        timestamp: 1_692_251_666_727,
        mode: 'active',
        deliveryContext: { isRedelivery: false },
        replyToken: '38ef843bde154d9b91c21320ffd17a0f',
        source: { type: 'group', groupId, userId },
        message: declaredFile
          ? {
              id: messageId,
              type: 'file',
              fileName: 'report.bin',
              fileSize: 28
            }
          : {
              id: messageId,
              type: 'video',
              contentProvider: { type: 'line' },
              quoteToken: 'quote-token'
            }
      },
      {
        type: 'message',
        webhookEventId: textEventId,
        timestamp: 1_692_251_666_728,
        mode: 'active',
        deliveryContext: { isRedelivery: false },
        replyToken: '49ef843bde154d9b91c21320ffd17a0f',
        source: { type: 'group', groupId, userId },
        message: {
          id: '468789577898262531',
          type: 'text',
          text: 'after media',
          quoteToken: 'text-quote-token'
        }
      }
    ]
  })
}

async function runtime(
  filename: string,
  worker?: WorkerOptions
): Promise<
  Awaited<ReturnType<typeof harness>> & {
    origin: string
    closeHttp(this: void): Promise<void>
  }
> {
  const local = await harness(
    createLineChannel(),
    config,
    groupId,
    userId,
    undefined,
    filename,
    worker
  )

  cleanup.push(local.close)

  const servers = createListeners(
    local.core,
    {
      observe: noopObservability,
      flush: async () => {},
      shutdown: async () => {}
    },
    () => true,
    () => true
  )

  const origin = await listen(servers.business, 0, '127.0.0.1')
  const closeHttp = async (): Promise<void> => closeServer(servers.business)
  cleanup.push(closeHttp)
  return { ...local, origin, closeHttp }
}

async function post(origin: string, body: string): Promise<number> {
  const signature = createHmac('sha256', 'secret').update(body).digest('base64')

  const response = await fetch(`${origin}/channels/business/webhook`, {
    method: 'POST',
    headers: { 'x-line-signature': signature },
    body
  })

  await response.arrayBuffer()
  return response.status
}

async function setup(): Promise<{
  remote: Awaited<ReturnType<typeof peer>>
  filename: string
}> {
  vi.stubEnv('LINE_SECRET', 'secret')
  vi.stubEnv('LINE_TOKEN', 'token')
  const remote = await peer()
  cleanup.push(remote.close)
  remote.identity(botId)
  const directory = await mkdtemp(join(tmpdir(), 'relanox-line-policy-'))
  cleanup.push(async () => rm(directory, { recursive: true }))
  return { remote, filename: join(directory, 'state.db') }
}

it.each([
  ['declared file size', true, { maxMediaBytes: 16 }, 0],
  ['downloaded byte size', false, { maxMediaBytes: 16 }, 2],
  ['core total byte size', false, { maxTotalMediaBytes: 16 }, 2]
] as const)(
  'acknowledges the known %s policy refusal and durably accepts later batch text',
  async (_name, declaredFile, worker, downloads) => {
    const { remote, filename } = await setup()
    remote.content({ status: 200, data: video, mimeType: 'video/mp4' })
    const local = await runtime(filename, worker)
    const body = batch(declaredFile)

    // LINE redelivers non-2xx webhooks; webhookEventId remains stable:
    // https://developers.line.biz/en/docs/messaging-api/receiving-messages/#redelivery
    expect(await post(local.origin, body)).toBe(200)
    expect(await post(local.origin, body)).toBe(200)
    const records = await local.storage.listInbound({ limit: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]?.snapshot).toMatchObject({
      source: { eventId: textEventId },
      text: 'after media'
    })
    expect(records[0]?.snapshot.attachments).toBeUndefined()
    expect(remote.traffic).toHaveLength(downloads)
    await local.core.processDue()
    expect(local.dispatches).toEqual(['after media'])
  }
)

it('withholds ACK for content HTTP 503 and recovers the whole batch after SQLite restart', async () => {
  const { remote, filename } = await setup()
  // Get content uses the authenticated native origin and HTTP failures are replayable:
  // https://developers.line.biz/en/reference/messaging-api/#get-content
  remote.content({
    status: 503,
    data: new Uint8Array(),
    mimeType: 'text/plain'
  })
  const local = await runtime(filename)
  const body = batch()
  expect(await post(local.origin, body)).toBe(500)
  expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
  expect(local.dispatches).toEqual([])
  expect(remote.traffic).toHaveLength(1)
  await local.closeHttp()
  cleanup.pop()
  await local.close()
  cleanup.pop()

  remote.content({ status: 200, data: video, mimeType: 'video/mp4' })
  const restarted = await runtime(filename)
  expect(await post(restarted.origin, body)).toBe(200)
  expect(await post(restarted.origin, body)).toBe(200)
  const records = await restarted.storage.listInbound({ limit: 10 })
  expect(records).toHaveLength(2)

  const media = records.find(
    (record) => record.snapshot.source.eventId === mediaEventId
  )

  expect(media?.snapshot.attachments).toMatchObject([
    { kind: 'video', mimeType: 'video/mp4', size: 28 }
  ])
  const attachment = media?.snapshot.attachments?.[0]
  if (!media || !attachment) {
    throw new Error('missing_persisted_video')
  }

  const stored = await restarted.storage.media?.get(
    media.snapshot.channel.id,
    attachment.id
  )

  expect(Buffer.from(stored?.data ?? [])).toEqual(video)
  expect(remote.traffic[1]).toMatchObject({
    path: `/v2/bot/message/${messageId}/content`,
    headers: { authorization: 'Bearer token' }
  })
  await restarted.core.processDue()
  expect(restarted.dispatches.toSorted()).toEqual(['', 'after media'])
})
