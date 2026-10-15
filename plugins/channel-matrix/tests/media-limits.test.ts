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
const file = new TextEncoder().encode('small native file')

// Native media and sync fields: matrix-js-sdk 43.0.0 src/@types/media.ts,
// Src/@types/sync.ts and https://spec.matrix.org/v1.16/client-server-api/#mfile.
function syncPage(since: string | null): unknown {
  return {
    next_batch: 'after-media',
    rooms: {
      join: {
        [room]: {
          timeline: {
            events: since
              ? []
              : [
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

// Protect Core's file/aggregate budgets after replacing the receive driver. A
// Lost host budget or swallowed total-limit rejection would persist the file.
// SDK callback timing is independent of downloads; real SQLite needs no seam.
it.each([
  {
    limit: 'file',
    maxMediaBytes: 16,
    maxTotalMediaBytes: 32,
    errorCode: 'media_too_large'
  },
  {
    limit: 'total',
    maxMediaBytes: 32,
    maxTotalMediaBytes: 16,
    errorCode: 'media_total_too_large'
  }
])(
  'rejects the local $limit byte excess while durably dispatching subsequent SDK text',
  async ({ maxMediaBytes, maxTotalMediaBytes, errorCode }) => {
    const dispatches: unknown[] = []
    const observation = observations()
    let downloads = 0

    const peer = await httpPeer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://peer')
      if (url.pathname.endsWith('/sync')) {
        json(response, syncPage(url.searchParams.get('since')))
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
      {
        worker: { maxMediaBytes, maxTotalMediaBytes },
        observe: observation.observe
      }
    )

    await plugin.start?.(new AbortController().signal)
    await waitFor(() =>
      observation.logs.some((entry) => entry.fields?.errorCode === errorCode)
    )
    await plugin.stop?.()
    expect(downloads).toBe(1)
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

it('advances SDK sync past a native empty file and preserves later text across SQLite restart', async () => {
  // Matrix SDK accepts zero-byte media; Matrix events can report info.size: 0.
  // https://github.com/matrix-org/matrix-js-sdk/pull/2155
  // https://spec.matrix.org/v1.15/client-server-api/#mfile
  const syncs: (string | null)[] = []
  const dispatches: unknown[] = []

  const peer = await httpPeer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://peer')
    if (url.pathname.endsWith('/sync')) {
      const since = url.searchParams.get('since')
      syncs.push(since)
      json(response, {
        next_batch: 'after-empty',
        rooms: {
          join: {
            [room]: {
              timeline: {
                events:
                  since === null
                    ? [
                        {
                          event_id: '$empty-file',
                          sender,
                          type: 'm.room.message',
                          content: {
                            msgtype: 'm.file',
                            body: 'empty.txt',
                            url: 'mxc://media.example.org/empty',
                            info: { mimetype: 'text/plain', size: 0 }
                          }
                        },
                        {
                          event_id: '$later-text',
                          sender,
                          type: 'm.room.message',
                          content: {
                            msgtype: 'm.text',
                            body: 'still delivered'
                          }
                        }
                      ]
                    : []
              }
            }
          }
        }
      })
    } else if (url.pathname.includes('/media/download/')) {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': '0'
      })
      response.end()
    } else {
      dispatches.push(await body(request))
      json(response, {})
    }
  })

  const firstPlugin = createMatrixChannel({ MATRIX_TOKEN: 'matrix-secret' })

  const first = await harness(
    firstPlugin,
    config(peer.base),
    [{ chatId: room }],
    [sender],
    `${peer.base}/dispatch`
  )

  await firstPlugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      syncs.includes('after-empty') &&
      (await first.storage.listInbound({ limit: 10 })).length === 1
  )
  await firstPlugin.stop?.()
  await first.storage.close()

  const restartedPlugin = createMatrixChannel({ MATRIX_TOKEN: 'matrix-secret' })

  const restarted = await harness(
    restartedPlugin,
    config(peer.base),
    [{ chatId: room }],
    [sender],
    `${peer.base}/dispatch`,
    { filename: first.filename }
  )

  const restartIndex = syncs.length
  await restartedPlugin.start?.(new AbortController().signal)
  await waitFor(() => syncs.length > restartIndex)
  await restartedPlugin.stop?.()
  expect(syncs[0]).toBeNull()
  expect(syncs.slice(0, restartIndex)).toContain('after-empty')
  // The official SDK keeps its cursor in MemoryStore; SQLite retains accepted work.
  expect(syncs[restartIndex]).toBeNull()
  const records = await restarted.storage.listInbound({ limit: 10 })
  expect(records).toHaveLength(1)
  expect(records[0]?.snapshot).toMatchObject({
    source: { eventId: '$later-text' },
    text: 'still delivered'
  })
  await restarted.runtime.processDue()
  expect(dispatches).toEqual([
    { channel: records[0]?.snapshot.channel.id, text: 'still delivered' }
  ])
})

// Media transport failure must never become an accepted input with missing bytes.
// The SDK owns sync progress and does not wait for asynchronous Core ingestion.
it('does not persist incomplete media when its download fails, while later SDK text still reaches Core', async () => {
  const observation = observations()
  let downloads = 0

  const peer = await httpPeer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://peer')
    if (url.pathname.endsWith('/sync')) {
      json(response, syncPage(url.searchParams.get('since')))
    } else if (url.pathname.includes('/media/download/')) {
      downloads += 1
      json(
        response,
        { errcode: 'M_UNKNOWN', error: 'Temporarily unavailable' },
        503
      )
    } else {
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
    { observe: observation.observe }
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(() =>
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'media_download_failed'
    )
  )
  await plugin.stop?.()
  expect(downloads).toBe(1)
  const records = await fixture.storage.listInbound({ limit: 10 })
  expect(records).toHaveLength(1)
  expect(records[0]?.snapshot.source.eventId).toBe('$following-text')
})
