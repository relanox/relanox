import { rm } from 'node:fs/promises'
import type {
  EndpointConfig,
  Storage,
  RelanoxConfig,
  AccountConfig,
  Binding,
  Json
} from '@relanox/sdk'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { startRuntime } from '../src/runtime.js'
import { deadline } from '../src/deadline.js'
import { fixture, storage } from './fixture.js'
import {
  freeManagementPort,
  nativePeers,
  routinePeer,
  sqliteWriteLock
} from './startup-peer.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  vi.unstubAllEnvs()
})

function endpoint(mode: 'pull' | 'push' = 'pull'): EndpointConfig {
  return {
    id: 'agent',
    agent: 'grok',
    dispatchMode: mode,
    config: {
      mcp: {
        token: { env: 'START_AGENT_TOKEN' },
        allowedHosts: ['127.0.0.1:8787']
      },
      routineUrl: { env: 'START_ROUTINE_URL' },
      routineAuthorization: { env: 'START_ROUTINE_AUTH' },
      routineTransport: 'loopback-http',
      timeoutMs: 2000
    }
  }
}

async function databaseFixture(): Promise<{
  database: Awaited<ReturnType<typeof storage>>
  directory: string
  filename: string
  configPath: string
  config: {
    relay: RelanoxConfig
    server: {
      port: number
      managementPort: number
      workerIntervalMs: number
      workerStaleMs: number
    }
  }
  save(this: void, input?: unknown): Promise<void>
}> {
  const value = await fixture()
  cleanups.push(async () => {
    await rm(value.directory, { recursive: true, force: true })
  })
  const database = await storage(value.filename)
  await database.initialize()
  cleanups.push(async () => {
    await database.close()
  })
  return { ...value, database }
}

test("accepts native text during another channel's initialization while management remains unready", async () => {
  const value = await databaseFixture()
  vi.stubEnv('START_WECOM_SECRET', 'secret')
  vi.stubEnv('START_DING_SECRET', 'secret')
  const peers = await nativePeers()
  cleanups.push(peers.close)
  const managementPort = await freeManagementPort()

  const config = {
    relay: {
      ...value.config.relay,
      accounts: [
        {
          id: 'fast',
          channel: 'wecom',
          allowedSenders: ['user'],
          config: {
            botId: 'robot',
            secret: { env: 'START_WECOM_SECRET' },
            wsUrl: `${peers.origin.replace('http:', 'ws:')}/wecom`,
            allowInsecureLoopback: true,
            heartbeatMs: 1000,
            maxReconnectAttempts: 0
          }
        },
        {
          id: 'slow',
          channel: 'dingtalk',
          allowedSenders: ['staff'],
          config: {
            clientId: 'app',
            clientSecret: { env: 'START_DING_SECRET' },
            robotCode: 'robot',
            apiBase: peers.origin,
            allowInsecureLoopback: true,
            maxReconnectAttempts: 0
          }
        }
      ],
      endpoints: [endpoint()],
      bindings: [{ accountId: 'fast', chatId: 'user', endpointId: 'agent' }]
    },
    server: { ...value.config.server, managementPort, startupTimeoutMs: 5000 }
  }

  const starting = startRuntime(config)
  let runtime: Awaited<ReturnType<typeof startRuntime>> | null = null
  void starting.catch(() => {})
  try {
    await deadline(Promise.all([peers.discovered, peers.authenticated]), 3000)
    expect(
      (await fetch(`http://127.0.0.1:${managementPort}/health/ready`)).status
    ).toBe(503)
    peers.publish()
    await expect
      .poll(async () => (await value.database.getStats()).pending, {
        timeout: 1000
      })
      .toBe(1)
    expect(peers.fastClosed).toBe(false)

    const [request] = await value.database.listPending({
      agent: 'grok',
      endpointIds: ['agent'],
      limit: 10
    })

    expect(request).toMatchObject({
      text: 'message during startup',
      source: { channel: 'wecom', accountId: 'fast', eventId: 'startup-event' },
      endpoint: { id: 'agent' },
      target: { chatId: 'user' }
    })
    peers.releaseDiscovery()
    runtime = await starting
    await expect
      .poll(
        async () =>
          (await fetch(`${runtime?.managementUrl}/health/ready`)).status
      )
      .toBe(200)
  } finally {
    peers.releaseDiscovery()
    runtime ??= await starting.catch(() => null)
    await runtime?.stop()
  }
})

async function recoveredNotification(): Promise<{
  remote: Awaited<ReturnType<typeof routinePeer>>
  config: {
    relay: {
      endpoints: EndpointConfig[]
      accounts: readonly AccountConfig[]
      bindings: readonly Binding[]
      storage: {
        readonly plugin: 'sqlite' | 'postgres'
        readonly config: Json
      }
      observability: {
        readonly plugin: 'standard' | 'none'
        readonly config: Json
      }
    }
    server: {
      startupTimeoutMs: number
      shutdownTimeoutMs: number
      port: number
      managementPort: number
      workerIntervalMs: number
      workerStaleMs: number
    }
  }
  database: Storage
  directory: string
  filename: string
  configPath: string
  save(this: void, input?: unknown): Promise<void>
}> {
  const value = await databaseFixture()
  const remote = await routinePeer()
  cleanups.push(remote.close)
  vi.stubEnv('START_ROUTINE_URL', `${remote.origin}/routine`)
  vi.stubEnv('START_ROUTINE_AUTH', 'Bearer secret')
  const agent = endpoint('push')
  await value.database.acceptInbound({
    requestId: 'recovered-request',
    source: { channel: 'telegram', accountId: 'bot', eventId: 'event' },
    senderId: 'user',
    text: 'persisted backlog',
    target: {
      channel: 'telegram',
      accountId: 'bot',
      chatId: 'chat',
      data: null
    },
    context: null,
    receivedAt: 1,
    acceptedAt: 1,
    endpoint: agent
  })

  const config = {
    relay: { ...value.config.relay, endpoints: [agent] },
    server: {
      ...value.config.server,
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 1000
    }
  }

  return { ...value, remote, config }
}

test('returns from startup before a valid initial backlog receipt and gates readiness on settlement', async () => {
  const value = await recoveredNotification()
  const starting = startRuntime(value.config)
  let runtime: Awaited<ReturnType<typeof startRuntime>> | null = null
  void starting.catch(() => {})
  try {
    await deadline(value.remote.received, 1000)
    runtime = await deadline(starting, 400)
    expect((await fetch(`${runtime.managementUrl}/health/ready`)).status).toBe(
      503
    )
    expect(value.remote.requests).toHaveLength(1)

    const notification = z
      .object({ content: z.string() })
      .parse(JSON.parse(value.remote.requests[0]?.body ?? 'null') as unknown)

    expect(JSON.parse(notification.content) as unknown).toMatchObject({
      requestId: 'recovered-request',
      text: 'persisted backlog'
    })
    value.remote.release()
    await expect
      .poll(
        async () =>
          (await fetch(`${runtime?.managementUrl}/health/ready`)).status
      )
      .toBe(200)
    expect(
      (await value.database.getInbound('recovered-request'))?.dispatch.status
    ).toBe('accepted')
  } finally {
    value.remote.release()
    runtime ??= await starting.catch(() => null)
    await runtime?.stop()
  }
})

test('shutdown waits for the asynchronously launched first batch to settle in real storage', async () => {
  const value = await recoveredNotification()
  const second = { ...endpoint('push'), id: 'second' }
  await value.database.acceptInbound({
    requestId: 'next-process-request',
    source: { channel: 'telegram', accountId: 'bot', eventId: 'second-event' },
    senderId: 'user',
    text: 'next process backlog',
    target: {
      channel: 'telegram',
      accountId: 'bot',
      chatId: 'chat',
      data: null
    },
    context: null,
    receivedAt: 2,
    acceptedAt: 2,
    endpoint: second
  })

  const config = {
    ...value.config,
    relay: {
      ...value.config.relay,
      endpoints: [...value.config.relay.endpoints, second]
    }
  }

  const starting = startRuntime(config)
  let runtime: Awaited<ReturnType<typeof startRuntime>> | null = null
  void starting.catch(() => {})
  try {
    await deadline(value.remote.received, 1000)
    runtime = await deadline(starting, 400)
    let stopped = false

    const stopping = runtime.stop().then(() => {
      stopped = true
      return true
    })

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40)
    })
    expect(stopped).toBe(false)
    expect(value.remote.requests).toHaveLength(1)
    value.remote.release()
    await stopping
    expect(
      (await value.database.getInbound('recovered-request'))?.dispatch
    ).toMatchObject({
      status: 'accepted',
      attempts: 1
    })
    expect(value.remote.requests).toHaveLength(1)
    expect(
      (await value.database.getInbound('next-process-request'))?.dispatch
    ).toEqual({
      status: 'due',
      attempts: 0,
      dueAt: 2
    })
    runtime = await startRuntime(config)
    await expect
      .poll(
        async () =>
          (await value.database.getInbound('next-process-request'))?.dispatch
            .status
      )
      .toBe('accepted')
    expect(value.remote.requests).toHaveLength(2)
  } finally {
    value.remote.release()
    runtime ??= await starting.catch(() => null)
    await runtime?.stop()
  }
})

test('contains a real first-scan SQLite lock failure and recovers readiness after unlock', async () => {
  const value = await databaseFixture()
  const peers = await nativePeers()
  cleanups.push(peers.close)
  vi.stubEnv('START_DING_SECRET', 'secret')

  const starting = startRuntime({
    ...value.config,
    server: { ...value.config.server, startupTimeoutMs: 5000 },
    relay: {
      ...value.config.relay,
      storage: {
        plugin: 'sqlite',
        config: { filename: value.filename, busyTimeoutMs: 1 }
      },
      accounts: [
        {
          id: 'slow',
          channel: 'dingtalk',
          allowedSenders: ['staff'],
          config: {
            clientId: 'app',
            clientSecret: { env: 'START_DING_SECRET' },
            robotCode: 'robot',
            apiBase: peers.origin,
            allowInsecureLoopback: true,
            maxReconnectAttempts: 0
          }
        }
      ]
    }
  })

  void starting.catch(() => {})
  await deadline(peers.discovered, 3000)
  const locker = await sqliteWriteLock(value.filename)
  cleanups.push(locker.close)
  peers.releaseDiscovery()
  const runtime = await starting
  cleanups.push(runtime.stop)
  expect((await fetch(`${runtime.managementUrl}/health/ready`)).status).toBe(
    503
  )
  await locker.close()
  await expect
    .poll(
      async () => (await fetch(`${runtime.managementUrl}/health/ready`)).status
    )
    .toBe(200)
})
