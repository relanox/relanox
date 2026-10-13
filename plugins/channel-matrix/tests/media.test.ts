import { expect, it } from 'vitest'
import { createMatrixChannel } from '../src/index.js'
import { body, httpPeer, json, waitFor } from './harness.js'
import { mediaRelay } from './media-harness.js'

const kinds = [
  ['image', 'image/png', 'picture.png', 201, 'sent'],
  ['audio', 'audio/ogg', 'voice.ogg', 201, 'sent'],
  ['video', 'video/mp4', 'clip.mp4', 201, 'sent'],
  ['file', 'application/pdf', 'report.pdf', 201, 'sent'],
  ['image', 'image/png', 'picture.png', 429, 'pending'],
  ['image', 'image/png', 'picture.png', 403, 'rejected'],
  ['image', 'image/png', 'picture.png', 503, 'pending'],
  ['image', 'image/png', 'picture.png', 200, 'pending']
] as const

it.each(kinds)(
  'relays native Matrix %s (%s, %s) upload HTTP %s settles %s through SQLite and authenticated MCP',
  async (kind, mimeType, fileName, uploadStatus, expected) => {
    let syncs = 0
    const downloads: { path: string; authorization: string | undefined }[] = []

    const uploads: {
      bytes: Uint8Array
      mimeType: string | undefined
      filename: string | null
    }[] = []

    const sent: unknown[] = []

    const peer = await httpPeer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://peer')
      if (url.pathname.endsWith('/sync')) {
        syncs++
        json(response, {
          next_batch: 'after-media',
          rooms: {
            join: {
              '!room:example': {
                timeline: {
                  events:
                    syncs === 1
                      ? [
                          {
                            event_id: '$media',
                            sender: '@alice:example',
                            type: 'm.room.message',
                            content: {
                              msgtype: `m.${kind}`,
                              body: 'Caption '.repeat(50),
                              filename: fileName,
                              url: 'mxc://remote.example/original',
                              info: {
                                mimetype: mimeType,
                                ...(kind === 'audio' || kind === 'video'
                                  ? { duration: 1500 }
                                  : {})
                              },
                              'm.relates_to': {
                                rel_type: 'm.thread',
                                event_id: '$thread'
                              }
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
        downloads.push({
          path: url.pathname,
          authorization: request.headers.authorization
        })
        response.writeHead(200, { 'Content-Type': mimeType })
        response.end(new Uint8Array([1, 2, 3]))
      } else if (url.pathname.endsWith('/upload')) {
        const parts: Uint8Array[] = []
        for await (const part of request) {
          parts.push(part as Uint8Array)
        }
        uploads.push({
          bytes: new Uint8Array(Buffer.concat(parts)),
          mimeType: request.headers['content-type'],
          filename: url.searchParams.get('filename')
        })
        json(
          response,
          uploadStatus === 201
            ? { content_uri: 'mxc://homeserver.example/generated' }
            : {},
          uploadStatus
        )
      } else if (url.pathname.includes('/state/')) {
        // Missing room encryption state: Matrix Client-Server v1.15 state endpoint.
        // https://spec.matrix.org/v1.15/client-server-api/#get_matrixclientv3roomsroomidstateeventtypestatekey
        json(response, { errcode: 'M_NOT_FOUND' }, 404)
      } else {
        sent.push(await body(request))
        json(response, { event_id: '$sent' })
      }
    })

    const plugin = createMatrixChannel({ MATRIX_TOKEN: 'matrix-secret' })

    const fixture = await mediaRelay(
      plugin,
      {
        homeserver: peer.base,
        accessToken: { env: 'MATRIX_TOKEN' },
        allowInsecureLocalhost: true
      },
      [{ chatId: '!room:example', threadId: '$thread' }],
      ['@alice:example']
    )

    await plugin.start?.(new AbortController().signal)
    await waitFor(
      async () =>
        (await fixture.storage.listInbound({ limit: 10 })).length === 1
    )
    await plugin.stop?.()
    const record = (await fixture.storage.listInbound({ limit: 10 }))[0]
    if (!record) {
      throw new Error('Missing request')
    }
    expect(record.snapshot.text).toBe('Caption '.repeat(50))

    const turn = await fixture.turn(record.snapshot.requestId, [
      {
        kind,
        mimeType,
        fileName,
        data: new Uint8Array([9, 8, 7]),
        ...(kind === 'audio' || kind === 'video' ? { durationMs: 1500 } : {})
      }
    ])

    expect(turn.inbound[0]?.reference).toMatchObject({
      kind,
      mimeType,
      fileName
    })
    expect(turn.inbound[0]?.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(downloads).toEqual([
      {
        path: '/_matrix/client/v1/media/download/remote.example/original',
        authorization: 'Bearer matrix-secret'
      }
    ])
    await fixture.runtime.processDue()
    expect(uploads).toEqual([
      { bytes: new Uint8Array([9, 8, 7]), mimeType, filename: fileName }
    ])
    if (expected !== 'sent') {
      expect(sent).toEqual([])
      expect((await fixture.storage.getOutbound(turn.deliveryId))?.status).toBe(
        expected
      )
      return
    }
    expect(sent).toEqual([
      {
        msgtype: `m.${kind}`,
        body: fileName,
        filename: fileName,
        url: 'mxc://homeserver.example/generated',
        info: {
          mimetype: mimeType,
          size: 3,
          ...(kind === 'audio' || kind === 'video' ? { duration: 1500 } : {})
        },
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: '$thread'
        }
      }
    ])
    expect((await fixture.storage.getOutbound(turn.deliveryId))?.status).toBe(
      'sent'
    )
  }
)

it('refuses oversized Matrix media without committing the sync cursor', async () => {
  let downloaded = false

  const peer = await httpPeer((request, response) => {
    if (request.url?.includes('/media/download/')) {
      downloaded = true
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': '17'
      })
      response.end(new Uint8Array(17))
    } else {
      json(response, {
        next_batch: 'must-not-commit',
        rooms: {
          join: {
            '!room:example': {
              timeline: {
                events: [
                  {
                    event_id: '$large',
                    sender: '@alice:example',
                    type: 'm.room.message',
                    content: {
                      msgtype: 'm.image',
                      body: 'large.png',
                      url: 'mxc://example/large'
                    }
                  }
                ]
              }
            }
          }
        }
      })
    }
  })

  const plugin = createMatrixChannel({ MATRIX_TOKEN: 'secret' })

  const fixture = await mediaRelay(
    plugin,
    {
      homeserver: peer.base,
      accessToken: { env: 'MATRIX_TOKEN' },
      allowInsecureLocalhost: true
    },
    [{ chatId: '!room:example' }],
    ['@alice:example'],
    16
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(() => downloaded)
  await plugin.stop?.()
  expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([])
  expect(
    await fixture.storage.getState(
      { pluginId: 'channel-matrix', ownerId: 'bot' },
      'sync'
    )
  ).toBeUndefined()
})
