import {
  installPeerNetwork,
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../../../packages/core/src/index.js'
import type { CoreOptions } from '../../../packages/core/src/index.js'
import { createSqliteStorage } from '@relanox/storage-sqlite'
import { createGrokAgentPlugin } from '../../agent-grok/src/index.js'
import { createDiscordChannel } from '../src/index.js'
import { discordPeer, mediaPeer } from './media-peer.js'

installPeerNetwork()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

const namespace = { pluginId: 'channel-discord', ownerId: 'dc' }

type Runtime = Awaited<ReturnType<typeof createCore>>

type Attachment = {
  id: string
  filename: string
  content_type: string
  size: number
  url: string
}

type Fixture = {
  runtime: Runtime
  gateway: Awaited<ReturnType<typeof discordPeer>>
  remote: Awaited<ReturnType<typeof mediaPeer>>
  readonly storage: ReturnType<typeof createSqliteStorage>
  attachment(this: void, path?: string, size?: number): Attachment
  failDownload(this: void, value: boolean): void
  restart(this: void): Promise<Runtime>
}

// Native attachment sizes and optional content_type follow discord.py at
// 65232c38702be5844cf2ce865a4777eb1928b5d0 discord/types/message.py.
// Gateway dispatch sequences and Resume are documented at
// https://docs.discord.com/developers/events/gateway#resuming
async function fixture(worker: CoreOptions['worker'] = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-discord-recovery-'))
  cleanups.push(async () => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'relay.sqlite')
  let storage = createSqliteStorage({ filename })
  let plugin = createDiscordChannel({ BOT: 'discord-token' })
  const agent = createGrokAgentPlugin()
  cleanups.push(async () => {
    await plugin.stop?.()
    await agent.stop?.()
    await storage.close()
  })
  vi.stubEnv('DISCORD_RECOVERY_MCP', 'test-token')
  vi.stubEnv('DISCORD_RECOVERY_ROUTINE', 'https://routine.test/routine')
  vi.stubEnv('DISCORD_RECOVERY_ROUTINE_AUTH', 'Bearer test')
  let failedDownload = false

  const remote = await mediaPeer((request) => {
    switch (request.path) {
      case '/users/@me': {
        return { json: { id: '999', bot: true } }
      }
      case '/gateway/bot': {
        return { json: { url: 'wss://gateway.discord.gg' } }
      }
      case '/large': {
        return { data: Uint8Array.of(1, 2, 3, 4, 5), mimeType: 'image/png' }
      }
      case '/empty': {
        return { data: new Uint8Array(), mimeType: 'image/png' }
      }
      case '/small': {
        return failedDownload
          ? { status: 503 }
          : { data: Uint8Array.of(9, 8), mimeType: 'image/png' }
      }
      default: {
        return { status: 404 }
      }
    }
  })

  cleanups.push(remote.close)
  const origin = registerPeer(remote.origin)
  routePlatform('https://discord.com', origin)
  const gateway = await discordPeer()
  cleanups.push(gateway.close)
  routePlatform('wss://gateway.discord.gg', gateway.url)

  async function start(): Promise<Runtime> {
    await storage.initialize()

    const runtime = await createCore({
      publicUrl: 'https://relay.example',
      storage,
      worker: { maxMediaBytes: 4, ...worker },
      channels: new Map([['dc', plugin]]),
      agents: new Map([['grok', agent]]),
      config: {
        accounts: [
          {
            id: 'dc',
            channel: 'discord',
            config: { botToken: { env: 'BOT' } },
            allowedSenders: ['42']
          }
        ],
        endpoints: [
          {
            id: 'agent',
            agent: 'grok',
            config: {
              mcp: { token: { env: 'DISCORD_RECOVERY_MCP' } },
              routineUrl: { env: 'DISCORD_RECOVERY_ROUTINE' },
              routineAuthorization: { env: 'DISCORD_RECOVERY_ROUTINE_AUTH' }
            }
          }
        ],
        bindings: [{ accountId: 'dc', chatId: '456', endpointId: 'agent' }],
        storage: { plugin: 'sqlite', config: {} },
        observability: { plugin: 'none', config: {} }
      }
    })

    await plugin.start?.(new AbortController().signal)
    return runtime
  }

  const runtime = await start()
  await expect
    .poll(
      async () => (await storage.getState(namespace, 'gateway-session'))?.value
    )
    .toMatchObject({ seq: 1 })
  remote.traffic.length = 0
  return {
    runtime,
    gateway,
    remote,
    get storage(): ReturnType<typeof createSqliteStorage> {
      return storage
    },
    attachment(path = '/small', size = 2): Attachment {
      return {
        id: '700',
        filename: 'incoming.png',
        content_type: 'image/png',
        size,
        url: `${origin}${path}`
      }
    },
    failDownload(value: boolean): void {
      failedDownload = value
    },
    async restart(): Promise<Runtime> {
      await plugin.stop?.()
      await storage.close()
      storage = createSqliteStorage({ filename })
      plugin = createDiscordChannel({ BOT: 'discord-token' })
      gateway.frames.length = 0
      return start()
    }
  }
}

function message(
  id: string,
  attachments: unknown[] = []
): Record<string, unknown> {
  return {
    id,
    channel_id: '456',
    content: attachments.length > 0 ? '' : 'later legal text',
    author: { id: '42' },
    type: 0,
    attachments
  }
}

it.each([
  { refusal: 'declared size', path: '/large', size: 5, count: 1, worker: {} },
  { refusal: 'downloaded size', path: '/large', size: 2, count: 1, worker: {} },
  { refusal: 'empty bytes', path: '/empty', size: 0, count: 1, worker: {} },
  {
    refusal: 'attachment count',
    path: '/small',
    size: 2,
    count: 2,
    worker: { maxAttachments: 1 }
  },
  {
    refusal: 'total bytes',
    path: '/small',
    size: 2,
    count: 2,
    worker: { maxTotalMediaBytes: 3 }
  }
])(
  'commits later text and Resume after a local media $refusal refusal',
  async ({ path, size, count, worker }) => {
    const test = await fixture(worker)

    const attachments = Array.from({ length: count }, (_, index) => ({
      ...test.attachment(path, size),
      id: String(700 + index)
    }))

    test.gateway.message(message('788', attachments), 2)
    test.gateway.message(message('789'), 3)
    await expect
      .poll(
        async () =>
          (await test.storage.getState(namespace, 'gateway-session'))?.value
      )
      .toMatchObject({ seq: 3 })
    expect(test.gateway.connected()).toBe(true)
    const records = await test.storage.listInbound({ limit: 10 })
    expect(records.map((record) => record.snapshot.source.eventId)).toEqual([
      '789'
    ])
    expect((await test.runtime.status()).requests).toHaveLength(1)
    expect(records[0]?.snapshot.attachments).toBeUndefined()
    expect(test.remote.traffic.map((request) => request.path)).toEqual(
      size > 4 ? [] : Array.from({ length: count }, () => path)
    )
    await test.restart()
    await expect
      .poll(() => test.gateway.frames)
      .toContainEqual({
        op: 6,
        d: { token: 'discord-token', session_id: '777', seq: 3 }
      })
    expect(
      (await test.storage.listInbound({ limit: 10 })).map(
        (record) => record.snapshot.source.eventId
      )
    ).toEqual(['789'])
  }
)

it.each(['media 503', 'closed SQLite'] as const)(
  'replays a transient %s after reopening SQLite without skipping later dispatches',
  async (failure) => {
    const test = await fixture()
    test.failDownload(failure === 'media 503')
    if (failure === 'closed SQLite') {
      await test.storage.close()
      expect((await test.storage.health()).ok).toBe(false)
    }
    test.gateway.message(message('788', [test.attachment()]), 2)
    test.gateway.message(message('789'), 3)
    await expect.poll(() => test.gateway.connected()).toBe(false)
    expect(test.remote.traffic.map((request) => request.path)).toEqual([
      '/small'
    ])
    test.failDownload(false)
    await test.restart()
    await expect
      .poll(() => test.gateway.frames)
      .toContainEqual({
        op: 6,
        d: { token: 'discord-token', session_id: '777', seq: 1 }
      })
    expect(
      (await test.storage.getState(namespace, 'gateway-session'))?.value
    ).toMatchObject({ seq: 1 })
    expect(await test.storage.listInbound({ limit: 10 })).toEqual([])
    test.gateway.message(message('788', [test.attachment()]), 2)
    test.gateway.message(message('789'), 3)
    await expect
      .poll(
        async () =>
          (await test.storage.getState(namespace, 'gateway-session'))?.value
      )
      .toMatchObject({ seq: 3 })
    const records = await test.storage.listInbound({ limit: 10 })
    expect(
      records.map((record) => record.snapshot.source.eventId).toSorted()
    ).toEqual(['788', '789'])

    const snapshot = records.find(
      (record) => record.snapshot.source.eventId === '788'
    )?.snapshot

    const attachment = snapshot?.attachments?.[0]
    if (!snapshot || !attachment || !test.storage.media) {
      throw new Error('missing_persisted_attachment')
    }
    expect(
      (await test.storage.media.get(snapshot.channel.id, attachment.id))?.data
    ).toEqual(Uint8Array.of(9, 8))
  }
)
