import { expect, it } from 'vitest'
import { createMatrixChannel } from '../src/index.js'
import {
  body,
  harness,
  httpPeer,
  json,
  observations,
  waitFor
} from './harness.js'

const room = '!room:example.org'
const sender = '@alice:example.org'
const namespace = { pluginId: 'channel-matrix', ownerId: 'bot' }
const file = new TextEncoder().encode('small native file')

// Matrix JS SDK d633e7c1954a6b92597fbc3f8a95f183789a8d40:
// Src/sync-accumulator.ts IRoomEvent and src/@types/media.ts FileContent.
// https://spec.matrix.org/v1.15/client-server-api/#mfile
// https://spec.matrix.org/v1.15/client-server-api/#get_matrixclientv3sync
function syncPage(since: string | null): unknown {
  return {
    next_batch: 'after-media',
    rooms: {
      join: {
        [room]: {
          timeline: {
            events:
              since === 'before-media'
                ? [
                    {
                      event_id: '$file',
                      sender,
                      type: 'm.room.message',
                      content: {
                        msgtype: 'm.file',
                        body: 'small.txt',
                        url: 'mxc://media.example.org/small',
                        info: { mimetype: 'text/plain', size: 17 }
                      }
                    },
                    {
                      event_id: '$following-text',
                      sender,
                      type: 'm.room.message',
                      content: { msgtype: 'm.text', body: 'following text' }
                    }
                  ]
                : []
          }
        }
      }
    }
  }
}

function config(base: string): {
  homeserver: string
  accessToken: { env: string }
  allowInsecureLocalhost: boolean
} {
  return {
    homeserver: base,
    accessToken: { env: 'MATRIX_TOKEN' },
    allowInsecureLocalhost: true
  }
}

it.each([
  { limit: 'file', maxMediaBytes: 16, maxTotalMediaBytes: 32 },
  { limit: 'total', maxMediaBytes: 32, maxTotalMediaBytes: 16 }
])(
  'advances sync past a local $limit byte refusal and durably dispatches subsequent text',
  async ({ maxMediaBytes, maxTotalMediaBytes }) => {
    const syncs: (string | null)[] = []
    const dispatches: unknown[] = []
    let downloads = 0

    const peer = await httpPeer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://peer')
      if (url.pathname.endsWith('/sync')) {
        const since = url.searchParams.get('since')
        syncs.push(since)
        json(response, syncPage(since))
      } else if (url.pathname.includes('/media/download/')) {
        downloads += 1
        response.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': '17'
        })
        response.end(file)
      } else {
        dispatches.push(await body(request))
        json(response, {})
      }
    })

    const plugin = createMatrixChannel({ MATRIX_TOKEN: 'matrix-secret' })

    const fixture = await harness(
      plugin,
      config(peer.base),
      [{ chatId: room }],
      [sender],
      `${peer.base}/dispatch`,
      { worker: { maxMediaBytes, maxTotalMediaBytes } }
    )

    await fixture.storage.compareAndSetState(namespace, {
      key: 'sync',
      expectedVersion: null,
      value: 'before-media'
    })
    await plugin.start?.(new AbortController().signal)
    await waitFor(() => syncs.length >= 2)
    await plugin.stop?.()
    expect(syncs.slice(0, 2)).toEqual(['before-media', 'after-media'])
    expect(downloads).toBe(1)
    expect((await fixture.storage.getState(namespace, 'sync'))?.value).toBe(
      'after-media'
    )
    const records = await fixture.storage.listInbound({ limit: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]?.snapshot).toMatchObject({
      source: { eventId: '$following-text' },
      text: 'following text'
    })
    await fixture.runtime.processDue()
    expect(dispatches).toEqual([
      { channel: records[0]?.snapshot.channel.id, text: 'following text' }
    ])
  }
)

it('retains the sync token on media HTTP 503 and replays the complete batch after SQLite restart', async () => {
  const syncs: (string | null)[] = []
  const observation = observations()
  let available = false
  let downloads = 0

  const peer = await httpPeer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://peer')
    if (url.pathname.endsWith('/sync')) {
      const since = url.searchParams.get('since')
      syncs.push(since)
      json(response, syncPage(since))
    } else if (url.pathname.includes('/media/download/')) {
      downloads += 1
      if (available) {
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        response.end(file)
      } else {
        json(
          response,
          { errcode: 'M_UNKNOWN', error: 'Temporarily unavailable' },
          503
        )
      }
    } else {
      json(response, {})
    }
  })

  const firstPlugin = createMatrixChannel({ MATRIX_TOKEN: 'matrix-secret' })

  const first = await harness(
    firstPlugin,
    config(peer.base),
    [{ chatId: room }],
    [sender],
    `${peer.base}/dispatch`,
    { worker: { maxMediaBytes: 32 }, observe: observation.observe }
  )

  await first.storage.compareAndSetState(namespace, {
    key: 'sync',
    expectedVersion: null,
    value: 'before-media'
  })
  await firstPlugin.start?.(new AbortController().signal)
  await waitFor(() =>
    observation.logs.some((entry) => entry.fields?.errorCode === 'sync_failed')
  )
  await firstPlugin.stop?.()
  expect(await first.storage.listInbound({ limit: 10 })).toEqual([])
  expect((await first.storage.getState(namespace, 'sync'))?.value).toBe(
    'before-media'
  )
  await first.storage.close()
  available = true
  const nextPlugin = createMatrixChannel({ MATRIX_TOKEN: 'matrix-secret' })

  const next = await harness(
    nextPlugin,
    config(peer.base),
    [{ chatId: room }],
    [sender],
    `${peer.base}/dispatch`,
    { filename: first.filename, worker: { maxMediaBytes: 32 } }
  )

  await nextPlugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (await next.storage.getState(namespace, 'sync'))?.value === 'after-media'
  )
  await nextPlugin.stop?.()
  expect(syncs.slice(0, 2)).toEqual(['before-media', 'before-media'])
  expect(downloads).toBe(2)
  const records = await next.storage.listInbound({ limit: 10 })
  expect(
    records.map((record) => record.snapshot.source.eventId).toSorted()
  ).toEqual(['$file', '$following-text'])

  const media = records.find(
    (record) => record.snapshot.source.eventId === '$file'
  )

  expect(media?.snapshot.attachments).toEqual([
    expect.objectContaining({ kind: 'file', mimeType: 'text/plain', size: 17 })
  ])
  const attachment = media?.snapshot.attachments?.[0]
  if (!attachment) {
    throw new Error('Missing recovered media')
  }
  expect(
    (await next.storage.media?.get(media.snapshot.channel.id, attachment.id))
      ?.data
  ).toEqual(file)
})
