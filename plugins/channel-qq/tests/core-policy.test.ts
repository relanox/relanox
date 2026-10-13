import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, test, vi } from 'vitest'
import { createCore } from '@relanox/core'
import { sqliteStoragePlugin } from '@relanox/storage-sqlite'
import type { AgentPlugin, Storage } from '@relanox/sdk'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { createQqChannel } from '../src/index.js'
import { wireText } from '../src/transport.js'
import {
  peer,
  records,
  temporaryDatabase
} from '../../channel-wecom/tests/test-support.js'

installPeerNetwork()

type Scenario = 'aggregate' | 'count' | 'invalid_metadata'

type Fixture = AsyncDisposable & {
  readonly remote: Awaited<ReturnType<typeof peer>>
  readonly storage: Storage
  start(this: void): Promise<void>
}

// Native C2C attachments is an array, with no singleton restriction in the schema.
// The count case uses two ordinary files and a configured limit of one.
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html#schema-messageattachment
// https://github.com/tencent-connect/qqbot-nodejs/blob/f77fab29e78f5c69a4194237aab81e12f41afb3e/src/protocol/types.ts#L247-L255
function messages(
  socket: WebSocket,
  origin: string,
  scenario: Scenario,
  recovered: boolean
): void {
  const attachments = [
    {
      url: `${origin}/file/1`,
      filename: scenario === 'invalid_metadata' && !recovered ? '' : 'one.txt',
      content_type: 'file'
    }
  ]

  if (scenario === 'count') {
    attachments.push({
      url: `${origin}/file/2`,
      filename: 'two.txt',
      content_type: 'file'
    })
  }

  const common = {
    timestamp: new Date().toISOString(),
    message_type: 0,
    author: { user_openid: 'user' }
  }

  socket.send(
    JSON.stringify({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: { ...common, id: 'files', content: '', attachments }
    })
  )
  socket.send(
    JSON.stringify({
      op: 0,
      s: 3,
      t: 'C2C_MESSAGE_CREATE',
      d: { ...common, id: 'following', content: 'Still here' }
    })
  )
}

async function fixture(scenario: Scenario): Promise<Fixture> {
  vi.stubEnv('QQ_SECRET', 'secret')
  let address = ''

  const remote = await peer(
    (request) => {
      if (request.path === '/app/getAppAccessToken') {
        return { body: { access_token: 'token', expires_in: 7200 } }
      }
      if (request.path.startsWith('/file/')) {
        return {
          body: Buffer.from('hello'),
          headers: { 'content-type': 'text/plain', 'content-length': '5' }
        }
      }
      return { body: { url: address } }
    },
    (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }))
      socket.on('message', (data) => {
        const received = z
          .object({ op: z.number(), d: z.unknown().optional() })
          .parse(JSON.parse(wireText(data)))

        if (received.op === 2) {
          socket.send(
            JSON.stringify({
              op: 0,
              s: 1,
              t: 'READY',
              d: { session_id: 'session' }
            })
          )
        }
        if (received.op === 6) {
          // QQ replay is bounded by the client's native Resume sequence.
          if (z.object({ seq: z.number().int() }).parse(received.d).seq === 1) {
            messages(socket, remote.http, scenario, true)
          }
          socket.send(JSON.stringify({ op: 0, s: 4, t: 'RESUMED', d: '' }))
        }
        if (received.op === 1) {
          socket.send(JSON.stringify({ op: 11 }))
        }
      })
    }
  )

  address = remote.ws
  const filename = await temporaryDatabase()

  const storage = await sqliteStoragePlugin.setup(
    { filename },
    {
      log() {},
      count() {},
      record() {},
      span() {
        return { end(): void {} }
      }
    }
  )

  await storage.initialize()
  const plugin = createQqChannel()
  const controller = new AbortController()

  const agent: AgentPlugin<unknown> = {
    id: 'grok',
    agent: 'grok',
    sdkMajor: 1,
    kind: 'agent',
    runtime: 'node',
    validateConfig: (value) => value,
    async setup() {},
    async dispatch() {
      return { status: 'accepted' }
    }
  }

  const worker = {
    maxMediaBytes: 8,
    maxTotalMediaBytes: scenario === 'aggregate' ? 4 : 16,
    maxAttachments: 1
  }

  let runtime: Awaited<ReturnType<typeof createCore>>
  try {
    runtime = await createCore({
      publicUrl: 'https://relay.example',
      config: {
        accounts: [
          {
            id: 'bot',
            channel: 'qq',
            allowedSenders: ['user'],
            config: { appId: 'app', clientSecret: { env: 'QQ_SECRET' } }
          }
        ],
        endpoints: [{ id: 'agent', agent: 'grok', config: {} }],
        bindings: [{ accountId: 'bot', chatId: 'user', endpointId: 'agent' }],
        storage: { plugin: 'sqlite', config: { filename } },
        observability: { plugin: 'none', config: {} }
      },
      worker,
      storage,
      channels: new Map([['bot', plugin]]),
      agents: new Map([['grok', agent]])
    })
  } catch (error) {
    await storage.close()
    throw error
  }
  return {
    remote,
    storage,
    async start() {
      await plugin.start?.(controller.signal)
      await expect
        .poll(async () => (await runtime.status()).connections['channels/bot'])
        .toBe('connected')
      const socket = remote.sockets[0]
      if (!socket) {
        throw new Error('missing_socket')
      }
      messages(socket, remote.http, scenario, false)
    },
    async [Symbol.asyncDispose]() {
      controller.abort()
      await plugin.stop?.()
      await storage.close()
    }
  }
}

test.each(['aggregate', 'count'] as const)(
  'QQ commits past a real Core %s media policy rejection and resumes after later text',
  async (scenario) => {
    await using local = await fixture(scenario)
    await local.start()
    await expect
      .poll(async () => (await records(local.storage)).length, {
        timeout: 3000
      })
      .toBe(1)
    expect((await records(local.storage))[0]?.snapshot.text).toBe('Still here')
    expect(
      local.remote.requests.filter((request) =>
        request.path.startsWith('/file/')
      )
    ).toHaveLength(scenario === 'count' ? 2 : 1)
    await expect
      .poll(() => local.remote.frames, { timeout: 3000 })
      .toContainEqual({ op: 1, d: 3 })
    local.remote.sockets[0]?.close(4009)
    await expect
      .poll(() => local.remote.frames, { timeout: 4000 })
      .toContainEqual({
        op: 6,
        d: { token: 'QQBot token', session_id: 'session', seq: 3 }
      })
  }
)

test('QQ keeps invalid Core media metadata uncommitted until the native event is corrected and replayed', async () => {
  await using local = await fixture('invalid_metadata')
  await local.start()
  await expect
    .poll(async () => (await records(local.storage)).length, { timeout: 4000 })
    .toBe(2)
  expect(local.remote.frames).toContainEqual({
    op: 6,
    d: { token: 'QQBot token', session_id: 'session', seq: 1 }
  })
  const saved = await records(local.storage)
  expect(saved.map((record) => record.snapshot.target.replyToId)).toEqual(
    expect.arrayContaining(['files', 'following'])
  )
  expect(
    saved.find((record) => record.snapshot.target.replyToId === 'files')
      ?.snapshot.attachments
  ).toEqual([
    expect.objectContaining({
      kind: 'file',
      mimeType: 'text/plain',
      fileName: 'one.txt',
      size: 5
    })
  ])
  expect(
    local.remote.requests.filter((request) => request.path.startsWith('/file/'))
  ).toHaveLength(2)
})
