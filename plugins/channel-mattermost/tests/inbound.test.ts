import { DatabaseSync } from 'node:sqlite'
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
    if (!url.searchParams.has('connection_id')) {
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
      const sequence = Number(url.searchParams.get('sequence_number') ?? '1')
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
  'advances the durable sequence after rejecting $name and preserves the later text across SQLite reopen',
  async ({ ids, size, worker }) => {
    const requests: string[] = []

    const peer = await httpPeer(
      (request, response) => {
        const path = request.url ?? ''
        requests.push(path)
        const id = path.split('/')[4]
        if (path.endsWith('/info')) {
          json(response, {
            id,
            name: 'file.bin',
            mime_type: 'application/octet-stream',
            size
          })
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

    const remote = stream(peer, [
      posted(1, firstPostId, ids),
      posted(2, nextPostId)
    ])

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
    expect(remote.upgrades).toEqual(['/api/v4/websocket'])
    const nativeRequests = [...requests]
    await initial.storage.close()
    const restored = await receiver(peer.base, worker, initial.filename)
    await restored.plugin.start?.(new AbortController().signal)
    await expect.poll(() => remote.upgrades.length).toBe(2)
    await restored.plugin.stop?.()
    expect(remote.upgrades[1]).toBe(
      '/api/v4/websocket?connection_id=abcdefghijklmnopqrstuvwxyz&sequence_number=3'
    )
    expect(requests).toEqual(nativeRequests)
    expect(
      (await restored.storage.listInbound({ limit: 10 })).map((record) => ({
        eventId: record.snapshot.source.eventId,
        text: record.snapshot.text
      }))
    ).toEqual([{ eventId: nextPostId, text: 'later text' }])
  }
)

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
          json(response, {
            id: firstFileId,
            name,
            mime_type: nativeMime,
            size: 3
          })
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

it.each(['download 503', 'metadata identity mismatch', 'SQLite write failure'])(
  'replays the failed sequence after %s and saves both messages once recovered',
  async (failure) => {
    let recovering = false

    const peer = await httpPeer(
      (request, response) => {
        if (request.url?.endsWith('/info')) {
          json(response, {
            id:
              !recovering && failure === 'metadata identity mismatch'
                ? secondFileId
                : firstFileId,
            name: 'file.bin',
            mime_type: 'application/octet-stream',
            size: 3
          })
        } else if (!recovering && failure === 'download 503') {
          json(response, {}, 503)
        } else {
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream'
          })
          response.end(new Uint8Array([0, 1, 2]))
        }
      },
      (_request, response) => {
        json(response, { id: botId })
      }
    )

    const remote = stream(peer, [
      posted(1, firstPostId, [firstFileId]),
      posted(2, nextPostId)
    ])

    const fixture = await receiver(peer.base, { maxMediaBytes: 4 })
    using database = new DatabaseSync(fixture.filename)
    if (failure === 'SQLite write failure') {
      database.exec(
        "CREATE TRIGGER fail_inbound BEFORE INSERT ON inbound BEGIN SELECT RAISE(FAIL, 'injected write failure'); END"
      )
    }
    await fixture.plugin.start?.(new AbortController().signal)
    await expect
      .poll(() =>
        fixture.logs.some((log) => log.fields?.errorCode === 'receive_failed')
      )
      .toBe(true)
    expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([])
    if (failure === 'SQLite write failure') {
      database.exec('DROP TRIGGER fail_inbound')
    }
    recovering = true
    await expect.poll(() => remote.upgrades.length, { timeout: 4000 }).toBe(2)
    await expect
      .poll(
        async () => (await fixture.storage.listInbound({ limit: 10 })).length
      )
      .toBe(2)
    await fixture.plugin.stop?.()
    expect(remote.upgrades[1]).toBe(
      '/api/v4/websocket?connection_id=abcdefghijklmnopqrstuvwxyz&sequence_number=1'
    )
    expect(
      (await fixture.storage.listInbound({ limit: 10 }))
        .map((record) => record.snapshot.source.eventId)
        .toSorted()
    ).toEqual([firstPostId, nextPostId])
  }
)
