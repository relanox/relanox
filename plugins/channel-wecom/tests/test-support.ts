import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '@relanox/core'
import type {
  AgentHost,
  AgentPlugin,
  ChannelPlugin,
  Json,
  SendInput,
  Storage,
  ScopedAgentHost,
  InboundRecord
} from '@relanox/sdk'
import { sqliteStoragePlugin } from '@relanox/storage-sqlite'
import { afterEach, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { wireText } from '../src/transport.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

export type HttpRequest = {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: unknown
}

export type HttpReply = {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: unknown
  readonly disconnect?: boolean
}

export async function peer(
  handle: (request: HttpRequest) => HttpReply | Promise<HttpReply>,
  connected: (socket: WebSocket) => void = () => {}
): Promise<{
  requests: HttpRequest[]
  frames: unknown[]
  sockets: WebSocket[]
  http: string
  ws: string
}> {
  const requests: HttpRequest[] = []
  const frames: unknown[] = []
  const sockets: WebSocket[] = []

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const chunks: Buffer[] = []
      for await (const part of request as AsyncIterable<unknown>) {
        if (!Buffer.isBuffer(part)) {
          throw new TypeError('Unexpected HTTP chunk')
        }
        chunks.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength))
      }
      const raw = Buffer.concat(chunks)
      const bytes = raw.toString()
      let body: unknown = null
      if (bytes) {
        body = request.headers['content-type']?.includes('application/json')
          ? (JSON.parse(bytes) as unknown)
          : raw
      }

      const input = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body
      }

      requests.push(input)
      const reply = await handle(input)
      if (reply.disconnect) {
        request.socket.destroy()
        return
      }
      response.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...reply.headers
      })
      response.end(
        Buffer.isBuffer(reply.body)
          ? reply.body
          : JSON.stringify(reply.body ?? {})
      )
    })().catch(() => {
      response.writeHead(500)
      response.end()
    })
  })

  const ws = new WebSocketServer({ server })
  ws.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      frames.push(JSON.parse(wireText(data)) as unknown)
    })
    connected(socket)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Missing local peer address')
  }
  cleanup.push(async () => {
    for (const socket of sockets) {
      socket.terminate()
    }
    await new Promise<void>((resolve) => {
      ws.close(() => {
        resolve()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  })
  return {
    requests,
    frames,
    sockets,
    http: `http://127.0.0.1:${address.port}`,
    ws: `ws://127.0.0.1:${address.port}`
  }
}

export async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-china-'))
  cleanup.push(async () => rm(directory, { recursive: true, force: true }))
  return join(directory, 'state.db')
}

export async function assemble<C>(
  plugin: ChannelPlugin<C>,
  config: Json,
  bindings: readonly { chatId: string; senderId: string }[],
  filename = ':memory:',
  publicUrl?: string
): Promise<{
  storage: Storage
  runtime: Awaited<ReturnType<typeof createCore>>
  controller: AbortController
  principal(this: void): ScopedAgentHost
  start(this: void): Promise<void | undefined>
}> {
  const storage = await sqliteStoragePlugin.setup(
    sqliteStoragePlugin.validateConfig({ filename }),
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
  cleanup.push(async () => {
    await plugin.stop?.()
    await storage.close()
  })
  let agentHost: AgentHost | undefined

  const agent: AgentPlugin<unknown> = {
    id: 'grok',
    agent: 'grok',
    sdkMajor: 1,
    kind: 'agent',
    runtime: 'node',
    validateConfig: (value) => value,
    async setup(value) {
      agentHost = value
    },
    async dispatch() {
      return { status: 'accepted' }
    }
  }

  const runtime = await createCore({
    publicUrl: publicUrl ?? 'https://relay.example',
    config: {
      accounts: [
        {
          id: 'bot',
          channel: plugin.channel,
          config,
          allowedSenders: [
            ...new Set(bindings.map((binding) => binding.senderId))
          ]
        }
      ],
      endpoints: [{ id: 'agent', agent: 'grok', config: {} }],
      bindings: bindings.map((binding) => ({
        accountId: 'bot',
        chatId: binding.chatId,
        endpointId: 'agent'
      })),
      storage: { plugin: 'sqlite', config: { filename } },
      observability: { plugin: 'none', config: {} }
    },
    storage,
    channels: new Map([['bot', plugin as ChannelPlugin<unknown>]]),
    agents: new Map([['grok', agent]])
  })

  const controller = new AbortController()
  cleanup.push(async () => {
    controller.abort()
    await plugin.stop?.()
  })
  return {
    storage,
    runtime,
    controller,
    principal: () => {
      if (!agentHost) {
        throw new Error('missing_agent_host')
      }
      return agentHost.forPrincipal({
        subject: 'verified-agent',
        endpointIds: ['agent']
      })
    },
    start: async () => plugin.start?.(controller.signal)
  }
}

export async function records(
  storage: Storage
): Promise<readonly InboundRecord[]> {
  return storage.listInbound({ limit: 100 })
}

export function sendInput(
  channel: SendInput['target']['channel'],
  chatId: string,
  data: Json,
  key = 'delivery:0'
): SendInput {
  return {
    deliveryId: 'delivery',
    requestId: 'request',
    chunkIndex: 0,
    signal: new AbortController().signal,
    target: { channel, accountId: 'bot', chatId, data },
    chunk: { text: 'hello_*世界', idempotencyKey: key, state: null }
  }
}
