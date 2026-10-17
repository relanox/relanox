import { installPeerNetwork } from '../../../plugins/channel-wecom/tests/network.js'
import { rm } from 'node:fs/promises'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { discoverConversations } from '../src/discovery.js'
import type { DiscoveryOutput } from '../src/discovery.js'
import { cli, fixture } from './fixture.js'
import { peer } from '../../../plugins/channel-wecom/tests/test-support.js'
import { wireText } from '../../../plugins/channel-wecom/src/transport.js'

// Load the workspace source at its package boundary so the socket network mapping applies.
vi.mock(
  import('@relanox/channel-wecom'),
  async () => import('../../../plugins/channel-wecom/src/index.js')
)

installPeerNetwork()

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true }))
  )
  vi.unstubAllEnvs()
})

async function draft(): Promise<Awaited<ReturnType<typeof fixture>>> {
  const value = await fixture()
  directories.push(value.directory)
  await value.save({
    relay: {
      accounts: [
        {
          id: 'wecom-main',
          channel: 'wecom',
          config: { botId: 'robot', secret: { env: 'DISCOVERY_SECRET' } }
        }
      ],
      endpoints: [{ unfinished: true }],
      bindings: [{ unfinished: true }]
    }
  })
  return value
}

test('discovery rejects callback accounts before starting a connection', async () => {
  const value = await fixture()
  directories.push(value.directory)
  await value.save({
    relay: {
      accounts: [
        {
          id: 'wecom-main',
          channel: 'wecom',
          config: {
            mode: 'webhook',
            botId: 'robot',
            token: { env: 'TOKEN' },
            encodingAESKey: { env: 'KEY' }
          }
        }
      ]
    }
  })
  const output: DiscoveryOutput[] = []
  await expect(
    discoverConversations({
      configPath: value.configPath,
      accountId: 'wecom-main',
      timeoutSeconds: 1,
      signal: new AbortController().signal,
      output: (entry) => output.push(entry)
    })
  ).rejects.toThrow('discovery_requires_websocket')
  expect(output).toEqual([])
})

test('discovery reports authenticated WeCom addresses from unfinished config without content, media fetches or sends', async () => {
  vi.stubEnv('DISCOVERY_SECRET', 'private-secret')
  const value = await draft()

  const event = (body: unknown): string =>
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'incoming' },
      body
    })

  const message = {
    msgid: 'first',
    aibotid: 'robot',
    chattype: 'group',
    chatid: 'group-42',
    from: { userid: 'member-17' },
    msgtype: 'text',
    text: { content: 'private-message' },
    response_url: 'https://secret.example/token'
  }

  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on('message', (bytes) => {
        const frame = z
          .object({
            cmd: z.string(),
            headers: z.object({ req_id: z.string() })
          })
          .parse(JSON.parse(wireText(bytes)))

        if (frame.cmd === 'aibot_subscribe') {
          socket.send(event({ ...message, chatid: 'before-authentication' }))
          socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
          setTimeout(() => {
            socket.send(
              event({ ...message, aibotid: 'other-bot', chatid: 'wrong-bot' })
            )
            socket.send(
              event({
                ...message,
                from: { userid: 'robot' },
                chatid: 'self-message'
              })
            )
            socket.send(event(message))
            socket.send(event(message))
            socket.send(
              event({
                ...message,
                msgid: 'media',
                chatid: 'media-group',
                msgtype: 'image',
                text: undefined,
                image: {
                  url: 'https://media.example/private',
                  aeskey: 'secret-media-key'
                }
              })
            )
          }, 20)
        }
      })
    }
  )

  const output: DiscoveryOutput[] = []
  const controller = new AbortController()

  const session = discoverConversations({
    configPath: value.configPath,
    accountId: 'wecom-main',
    timeoutSeconds: 5,
    signal: controller.signal,
    output: (entry) => output.push(entry)
  })

  try {
    await expect
      .poll(() => output.filter((entry) => entry.event === 'conversation'))
      .toEqual([
        {
          ok: true,
          event: 'conversation',
          accountId: 'wecom-main',
          channel: 'wecom',
          chatId: 'group-42',
          senderId: 'member-17'
        },
        {
          ok: true,
          event: 'conversation',
          accountId: 'wecom-main',
          channel: 'wecom',
          chatId: 'media-group',
          senderId: 'member-17'
        }
      ])
  } finally {
    controller.abort()
    await session
  }
  expect(output.at(-1)).toMatchObject({
    event: 'discovery_stopped',
    reason: 'signal'
  })
  expect(output.slice(0, 2)).toEqual([
    {
      ok: true,
      event: 'discovery_started',
      accountId: 'wecom-main',
      channel: 'wecom'
    },
    {
      ok: true,
      event: 'discovery_connected',
      accountId: 'wecom-main',
      channel: 'wecom'
    }
  ])
  expect(remote.requests).toEqual([])
  expect(remote.frames).toEqual([
    expect.objectContaining({ cmd: 'aibot_subscribe' })
  ])
  await expect.poll(() => remote.sockets[0]?.readyState).toBe(3)
})

test('discovery closes its authenticated connection at the requested deadline', async () => {
  vi.stubEnv('DISCOVERY_SECRET', 'private-secret')
  const value = await draft()

  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on('message', (bytes) => {
        const frame = z
          .object({ headers: z.object({ req_id: z.string() }) })
          .parse(JSON.parse(wireText(bytes)))

        socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
      })
    }
  )

  const output: DiscoveryOutput[] = []
  await discoverConversations({
    configPath: value.configPath,
    accountId: 'wecom-main',
    timeoutSeconds: 1,
    signal: new AbortController().signal,
    output: (entry) => output.push(entry)
  })
  expect(output.at(-1)).toMatchObject({
    event: 'discovery_stopped',
    reason: 'timeout'
  })
  await expect.poll(() => remote.sockets[0]?.readyState).toBe(3)
})

test('discover CLI rejects unbounded duration and missing credentials without exposing draft secrets', async () => {
  const value = await draft()

  const invalid = await cli(value.configPath, [
    'discover',
    '--account',
    'wecom-main',
    '--timeout',
    '601'
  ])

  const missing = await cli(value.configPath, [
    'discover',
    '--account',
    'wecom-main',
    '--timeout',
    '1'
  ])

  for (const result of [invalid, missing]) {
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: `${JSON.stringify({ ok: false, errorCode: 'command_failed' })}\n`
    })
  }
})
