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

// Native MESSAGE_CREATE author.id is the sender identity, not member nick or
// Attachment ownership. Gateway/message fixtures follow discord.py at
// 65232c38702be5844cf2ce865a4777eb1928b5d0 discord/types/message.py and
// https://docs.discord.com/developers/events/gateway-events#message-create
it('rejects denied attachment senders before HTTP while committing authorized native bytes', async () => {
  const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 255)
  const directory = await mkdtemp(join(tmpdir(), 'relanox-discord-auth-'))
  cleanups.push(async () => rm(directory, { recursive: true, force: true }))

  const storage = createSqliteStorage({
    filename: join(directory, 'relay.sqlite')
  })

  await storage.initialize()
  cleanups.push(async () => storage.close())

  const remote = await mediaPeer((request) => {
    switch (request.path) {
      case '/users/@me': {
        return { json: { id: '999', bot: true } }
      }
      case '/gateway/bot': {
        return { json: { url: 'wss://gateway.discord.gg' } }
      }
      case '/channels/456': {
        return { json: { id: '456', type: 0 } }
      }
      case '/asset': {
        return { data: bytes, mimeType: 'image/png' }
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
  const plugin = createDiscordChannel({ BOT: 'discord-token' })
  const agent = createGrokAgentPlugin()
  cleanups.push(async () => agent.stop?.())
  vi.stubEnv('DISCORD_TEST_MCP', 'test-token')
  vi.stubEnv('DISCORD_TEST_ROUTINE', 'https://routine.test/routine')
  vi.stubEnv('DISCORD_TEST_ROUTINE_AUTH', 'Bearer test')

  const runtime = await createCore({
    publicUrl: 'https://relay.example',
    storage,
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
            mcp: { token: { env: 'DISCORD_TEST_MCP' } },
            routineUrl: { env: 'DISCORD_TEST_ROUTINE' },
            routineAuthorization: { env: 'DISCORD_TEST_ROUTINE_AUTH' }
          }
        }
      ],
      bindings: [{ accountId: 'dc', chatId: '456', endpointId: 'agent' }],
      storage: { plugin: 'sqlite', config: {} },
      observability: { plugin: 'none', config: {} }
    }
  })

  cleanups.push(async () => plugin.stop?.())
  await plugin.start?.(new AbortController().signal)
  const namespace = { pluginId: 'channel-discord', ownerId: 'dc' }
  await expect
    .poll(
      async () => (await storage.getState(namespace, 'gateway-session'))?.value
    )
    .toMatchObject({ seq: 1 })
  remote.traffic.length = 0

  const message = {
    channel_id: '456',
    guild_id: '777',
    content: '',
    type: 0,
    attachments: [
      {
        id: '700',
        filename: 'incoming.png',
        content_type: 'image/png',
        size: bytes.length,
        url: `${origin}/asset`
      }
    ]
  }

  gateway.message(
    { ...message, id: '788', author: { id: '43' }, member: { nick: '42' } },
    2
  )
  await expect
    .poll(
      async () => (await storage.getState(namespace, 'gateway-session'))?.value
    )
    .toMatchObject({ seq: 2 })
  expect(remote.traffic).toEqual([])
  expect((await runtime.status()).requests).toEqual([])
  expect((await storage.getStats()).pending).toBe(0)
  gateway.message(
    { ...message, id: '789', author: { id: '42' }, member: { nick: '43' } },
    3
  )
  await expect
    .poll(async () => (await runtime.status()).requests.length)
    .toBe(1)
  const records = await storage.listInbound({ limit: 10 })
  const snapshot = records[0]?.snapshot
  expect(snapshot).toMatchObject({
    source: { eventId: '789' },
    senderId: '42',
    attachments: [
      {
        kind: 'image',
        mimeType: 'image/png',
        fileName: 'incoming.png',
        size: 10
      }
    ]
  })
  const attachment = snapshot?.attachments?.[0]
  if (!snapshot || !attachment || !storage.media) {
    throw new Error('missing_persisted_attachment')
  }
  expect(
    (await storage.media.get(snapshot.channel.id, attachment.id))?.data
  ).toEqual(bytes)
  expect(remote.traffic.map((request) => request.path)).toEqual([
    '/channels/456',
    '/asset'
  ])
  await expect
    .poll(
      async () => (await storage.getState(namespace, 'gateway-session'))?.value
    )
    .toMatchObject({ seq: 3 })
})
