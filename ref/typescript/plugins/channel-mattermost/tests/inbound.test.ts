import { createCore } from '@relanox/core'
import type { WorkerOptions } from '@relanox/core'
import { createSqliteStorage } from '@relanox/storage-sqlite'
import { expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { createGrokAgentPlugin } from '../../agent-grok/src/index.js'
import {
  cleanup,
  databaseFile,
  httpPeer,
  json,
  observations
} from '../../channel-matrix/tests/harness.js'
import { createMattermostChannel } from '../src/index.js'

const botId = 'bbbbbbbbbbbbbbbbbbbbbbbbbb'

const aliceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'

const channelId = 'cccccccccccccccccccccccccc'

const firstPostId = 'ppppppppppppppppppppppppp1'

const nextPostId = 'ppppppppppppppppppppppppp2'

const firstFileId = 'fffffffffffffffffffffffff1'

const secondFileId = 'fffffffffffffffffffffffff2'

const connectionId = 'abcdefghijklmnopqrstuvwxyz'

// Primary Mattermost 2b64fd09d3839007887662c191bd5d7af113a385:
// Server/public/model/post.go Post and PreCommit, file_info.go FileInfo/NewInfo,
// Channels/app/file.go UploadFileX, and channels/app/platform/web_conn.go replay.
// FileInfo uses native size and optional empty MIME, uploads allow empty files,
// And the authenticated reconnect query requests the next server sequence.
// SDK 11.9.0 Client4.getFileInfosForPost returns FileInfo[] for the post route.
// Protect media identity/budgets and later text in real HTTP/WS/Core/SQLite;
// An old per-file route or wrong batch association must fail. Existing fixtures
// Used only single-file objects and missed this contract. No new seam is needed.
function posted(
  seq: number,
  id: string,
  files: readonly string[] = []
): {
  event: string
  seq: number
  data: { post: string }
} {
  return {
    event: 'posted',
    seq,
    data: {
      post: JSON.stringify({
        id,
        user_id: aliceId,
        channel_id: channelId,
        root_id: '',
        message: files.length > 0 ? '' : 'later text',
        file_ids: files,
        type: '',
        create_at: 1_800_000_000_000
      })
    }
  }
}

function stream(
  peer: Awaited<ReturnType<typeof httpPeer>>,
  frames: readonly ReturnType<typeof posted>[]
): {
  server: WebSocketServer
  upgrades: string[]
} {
  const server = new WebSocketServer({
    server: peer.server,
    path: '/api/v4/websocket'
  })

  const upgrades: string[] = []
  server.on('connection', (socket, request) => {
    upgrades.push(request.url ?? '')
    const url = new URL(request.url ?? '', peer.base)
    if (!url.searchParams.get('connection_id')) {
      socket.send(
        JSON.stringify({
          event: 'hello',
          seq: 0,
          data: { connection_id: connectionId }
        })
      )
    }
    socket.once('message', () => {
      socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))

      const sequence = Math.max(
        1,
        Number(url.searchParams.get('sequence_number') ?? '1')
      )

      for (const frame of frames.filter(
        (candidate) => candidate.seq >= sequence
      )) {
        socket.send(JSON.stringify(frame))
      }
    })
  })
  cleanup(async () => {
    for (const socket of server.clients) {
      socket.terminate()
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })
  return { server, upgrades }
}

async function receiver(
  base: string,
  worker: WorkerOptions,
  filename?: string
): Promise<{
  plugin: ReturnType<typeof createMattermostChannel>
  storage: ReturnType<typeof createSqliteStorage>
  filename: string
  logs: ReturnType<typeof observations>['logs']
}> {
  vi.stubEnv('INBOUND_MATTERMOST_MCP', 'agent-secret')
  vi.stubEnv('INBOUND_MATTERMOST_ROUTINE', 'https://routine.example/routine')
  vi.stubEnv('INBOUND_MATTERMOST_ROUTINE_AUTH', 'Bearer routine-secret')
  const resolvedFilename = filename ?? (await databaseFile())
  const plugin = createMattermostChannel({ TOKEN: 'mattermost-secret' })
  const agent = createGrokAgentPlugin()
  const storage = createSqliteStorage({ filename: resolvedFilename })
  await storage.initialize()
  const observation = observations()
  cleanup(async () => {
    await plugin.stop?.()
    await agent.stop?.()
    await storage.close()
  })
  await createCore({
    publicUrl: 'https://relay.example',
    storage,
    worker,
    observe: observation.observe,
    channels: new Map([['bot', plugin]]),
    agents: new Map([['grok', agent]]),
    config: {
      accounts: [
        {
          id: 'bot',
          channel: 'mattermost',
          allowedSenders: [aliceId],
          config: {
            serverUrl: base,
            token: { env: 'TOKEN' },
            allowInsecureLocalhost: true
          }
        }
      ],
      endpoints: [
        {
          id: 'worker',
          agent: 'grok',
          config: {
            mcp: { token: { env: 'INBOUND_MATTERMOST_MCP' } },
            routineUrl: { env: 'INBOUND_MATTERMOST_ROUTINE' },
            routineAuthorization: { env: 'INBOUND_MATTERMOST_ROUTINE_AUTH' }
          }
        }
      ],
      bindings: [{ accountId: 'bot', endpointId: 'worker', chatId: channelId }],
      storage: { plugin: 'sqlite', config: {} },
      observability: { plugin: 'none', config: {} }
    }
  })
  return { plugin, storage, filename: resolvedFilename, logs: observation.logs }
}

const policies = [
  {
    name: 'file byte limit',
    ids: [firstFileId],
    size: 3,
    worker: { maxMediaBytes: 2 }
  },
  {
    name: 'empty native file',
    ids: [firstFileId],
    size: 0,
    worker: { maxMediaBytes: 2 }
  },
  {
    name: 'attachment count limit',
    ids: [firstFileId, secondFileId],
    size: 3,
    worker: { maxMediaBytes: 4, maxAttachments: 1 }
  },
  {
    name: 'aggregate byte limit',
    ids: [firstFileId, secondFileId],
    size: 3,
    worker: { maxMediaBytes: 4, maxTotalMediaBytes: 5 }
  }
]

it.each(policies)(
  'rejects $name while preserving subsequent SDK text in SQLite',
  async ({ ids, size, worker }) => {
    const requests: string[] = []

    const peer = await httpPeer(
      (request, response) => {
        const path = request.url ?? ''
        requests.push(path)
        if (path.endsWith('/info')) {
          json(
            response,
            ids.map((id) => ({
              id,
              name: 'file.bin',
              mime_type: 'application/octet-stream',
              size
            }))
          )
        } else {
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream'
          })
          response.end(new Uint8Array(size))
        }
      },
      (_request, response) => {
        json(response, { id: botId })
      }
    )

    stream(peer, [posted(1, firstPostId, ids), posted(2, nextPostId)])

    const initial = await receiver(peer.base, worker)
    await initial.plugin.start?.(new AbortController().signal)
    await expect
      .poll(
        async () => (await initial.storage.listInbound({ limit: 10 })).length
      )
      .toBe(1)
    await initial.plugin.stop?.()
    expect(
      (await initial.storage.listInbound({ limit: 10 })).map(
        (record) => record.snapshot.source.eventId
      )
    ).toEqual([nextPostId])
  }
)

// Protect each native file's identity, order and bytes when batch metadata arrives
// In a different order. Index-based pairing would silently swap attachments;
// Existing cases use one file or reject the whole post. SDK 11.9.0
// Client4.getFileInfosForPost returns FileInfo[] without an order guarantee.
// Real HTTP/WS/Core/SQLite use the existing production interfaces only.
it('associates unordered SDK file metadata with the post file identities', async () => {
  const requests: string[] = []

  const peer = await httpPeer(
    (request, response) => {
      const path = request.url ?? ''
      requests.push(path)
      if (path === `/api/v4/posts/${firstPostId}/files/info`) {
        json(response, [
          {
            id: secondFileId,
            name: 'second.pdf',
            mime_type: 'application/pdf',
            size: 2
          },
          {
            id: firstFileId,
            name: 'first.txt',
            mime_type: 'text/plain',
            size: 3
          }
        ])
      } else if (path === `/api/v4/files/${firstFileId}`) {
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        response.end(new Uint8Array([1, 2, 3]))
      } else if (path === `/api/v4/files/${secondFileId}`) {
        response.writeHead(200, { 'Content-Type': 'application/pdf' })
        response.end(new Uint8Array([4, 5]))
      } else {
        json(response, {}, 404)
      }
    },
    (_request, response) => {
      json(response, { id: botId })
    }
  )

  stream(peer, [posted(1, firstPostId, [firstFileId, secondFileId])])
  const fixture = await receiver(peer.base, { maxMediaBytes: 4 })
  await fixture.plugin.start?.(new AbortController().signal)
  await expect
    .poll(async () => (await fixture.storage.listInbound({ limit: 10 })).length)
    .toBe(1)
  await fixture.plugin.stop?.()
  const record = (await fixture.storage.listInbound({ limit: 10 }))[0]
  const attachments = record?.snapshot.attachments
  expect(attachments).toEqual([
    expect.objectContaining({
      kind: 'file',
      fileName: 'first.txt',
      mimeType: 'text/plain',
      size: 3
    }),
    expect.objectContaining({
      kind: 'file',
      fileName: 'second.pdf',
      mimeType: 'application/pdf',
      size: 2
    })
  ])
  if (!record || !attachments || !fixture.storage.media) {
    throw new Error('Missing persisted attachments')
  }
  const bytes: (Uint8Array | undefined)[] = []
  for (const attachment of attachments) {
    bytes.push(
      (
        await fixture.storage.media.get(
          record.snapshot.channel.id,
          attachment.id
        )
      )?.data
    )
  }
  expect(bytes).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
  expect(requests).toEqual([
    `/api/v4/posts/${firstPostId}/files/info`,
    `/api/v4/files/${firstFileId}`,
    `/api/v4/files/${secondFileId}`
  ])
})

// Mattermost FileInfo.IsValidFilename bounds names to 256 Unicode code points:
// 2b64fd09d3839007887662c191bd5d7af113a385 server/public/model/file_info.go.
it.each([
  {
    case: 'parameterized MIME',
    nativeMime: 'text/plain; charset=utf-8',
    name: 'note.txt',
    expectedMime: 'text/plain'
  },
  {
    case: 'empty MIME',
    nativeMime: '',
    name: 'file.unknownextension',
    expectedMime: 'application/octet-stream'
  },
  {
    case: '256 ASCII code points',
    nativeMime: 'application/octet-stream',
    name: `${'a'.repeat(252)}.bin`,
    expectedMime: 'application/octet-stream'
  },
  {
    case: '255 Unicode code points',
    nativeMime: 'application/octet-stream',
    name: `${'😀'.repeat(251)}.bin`,
    expectedMime: 'application/octet-stream'
  },
  {
    case: '256 Unicode code points',
    nativeMime: 'application/octet-stream',
    name: `${'😀'.repeat(252)}.bin`,
    expectedMime: 'application/octet-stream'
  }
])(
  'accepts native FileInfo $case without changing its name or bytes',
  async ({ nativeMime, name, expectedMime }) => {
    const data = new Uint8Array([0, 1, 2])

    const peer = await httpPeer(
      (request, response) => {
        if (request.url?.endsWith('/info')) {
          json(response, [
            {
              id: firstFileId,
              name,
              mime_type: nativeMime,
              size: 3
            }
          ])
        } else {
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream'
          })
          response.end(data)
        }
      },
      (_request, response) => {
        json(response, { id: botId })
      }
    )

    stream(peer, [posted(1, firstPostId, [firstFileId])])
    const fixture = await receiver(peer.base, { maxMediaBytes: 4 })
    await fixture.plugin.start?.(new AbortController().signal)
    await expect
      .poll(
        async () => (await fixture.storage.listInbound({ limit: 10 })).length
      )
      .toBe(1)
    await fixture.plugin.stop?.()
    const record = (await fixture.storage.listInbound({ limit: 10 }))[0]
    const reference = record?.snapshot.attachments?.[0]
    expect(reference).toMatchObject({
      kind: 'file',
      mimeType: expectedMime,
      fileName: name,
      size: 3
    })
    if (!reference || !fixture.storage.media) {
      throw new Error('Missing persisted media')
    }
    expect(
      (
        await fixture.storage.media.get(
          record.snapshot.channel.id,
          reference.id
        )
      )?.data
    ).toEqual(data)
  }
)

// SDK sequence progress does not wait for download/ingest callbacks. A failed
// Attachment must not become an accepted input with missing bytes, and unrelated
// Subsequent text must still reach Core. Native fields are sourced above.
it.each(['download 503', 'metadata identity mismatch'])(
  'refuses incomplete media after %s while accepting later SDK text',
  async (failure) => {
    let downloads = 0

    const peer = await httpPeer(
      (request, response) => {
        if (request.url?.endsWith('/info')) {
          json(response, [
            {
              id:
                failure === 'metadata identity mismatch'
                  ? secondFileId
                  : firstFileId,
              name: 'file.bin',
              mime_type: 'application/octet-stream',
              size: 3
            }
          ])
        } else {
          downloads += 1
          json(
            response,
            {
              id: 'api.test.download_error',
              message: 'Unavailable',
              status_code: 503
            },
            503
          )
        }
      },
      (_request, response) => {
        json(response, { id: botId })
      }
    )

    stream(peer, [posted(1, firstPostId, [firstFileId]), posted(2, nextPostId)])
    const fixture = await receiver(peer.base, { maxMediaBytes: 4 })
    await fixture.plugin.start?.(new AbortController().signal)
    await expect
      .poll(() =>
        fixture.logs.some((log) => log.fields?.errorCode === 'receive_failed')
      )
      .toBe(true)
    await fixture.plugin.stop?.()
    const records = await fixture.storage.listInbound({ limit: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]?.snapshot.source.eventId).toBe(nextPostId)
    expect(downloads).toBe(failure === 'metadata identity mismatch' ? 0 : 1)
  }
)
