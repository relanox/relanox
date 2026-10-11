import type { CoreRuntime } from '../../../packages/core/src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import { createCore } from '@relanox/core'
import type {
  AgentId,
  AgentPlugin,
  ChannelHost,
  ChannelPlugin,
  EndpointConfig,
  Json,
  MediaUpload,
  Storage,
  IngestReceipt
} from '@relanox/sdk'
import { createSqliteStorage } from '@relanox/storage-sqlite'

export type Traffic = {
  body: string
  headers: IncomingHttpHeaders
  url: string
}

export function parseWire(text: string): unknown {
  return JSON.parse(text) as unknown
}

export async function peer(
  reply: (traffic: Traffic) =>
    | { status: number; body?: string; headers?: Record<string, string> }
    | Promise<{
        status: number
        body?: string
        headers?: Record<string, string>
      }>
): Promise<{
  traffic: Traffic[]
  origin: string
  close(this: void): Promise<void>
}> {
  const traffic: Traffic[] = []

  async function receive(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const chunks: Buffer[] = []
    for await (const streamChunk of req) {
      const chunk: unknown = streamChunk
      if (!(chunk instanceof Uint8Array)) {
        throw new Error('unexpected_peer_bytes')
      }
      chunks.push(Buffer.from(new Uint8Array(chunk)))
    }

    const record = {
      body: Buffer.concat(chunks).toString(),
      headers: req.headers,
      url: req.url ?? ''
    }

    traffic.push(record)
    const result = await reply(record)
    res.writeHead(result.status, {
      'Content-Type': 'application/json',
      ...result.headers
    })
    res.end(result.body ?? '{}')
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      await receive(req, res)
    } catch (error) {
      res.destroy(error instanceof Error ? error : new Error('peer_failed'))
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('peer_address')
  }
  return {
    traffic,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => {
          if (error !== undefined) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
  }
}

export async function fixture(
  agent: AgentId,
  plugin: AgentPlugin<unknown>,
  configs: readonly Json[],
  push = true
): Promise<{
  endpoints: EndpointConfig[]
  filename: ReturnType<typeof join>
  sent: unknown[]
  wire: unknown[]
  readonly storage: Storage
  readonly core: CoreRuntime
  readonly agent: AgentPlugin<unknown>
  ingest(
    this: void,
    endpoint?: number,
    text?: string,
    event?: string,
    attachments?: readonly MediaUpload[]
  ): Promise<IngestReceipt>
  client(
    this: void,
    token?: string,
    endpoint?: number,
    modern?: boolean
  ): Promise<Client>
  reopen(this: void, next: AgentPlugin<unknown>): Promise<void>
  close(this: void): Promise<void>
}> {
  let currentPlugin = plugin
  const directory = await mkdtemp(join(tmpdir(), 'relanox-agent-'))
  const filename = join(directory, 'state.sqlite')
  let storage = createSqliteStorage({ filename, busyTimeoutMs: 5000 })
  await storage.initialize()
  let channelHost: ChannelHost | undefined
  const sent: unknown[] = []

  const channel: ChannelPlugin = {
    id: 'test-channel',
    kind: 'channel',
    channel: 'telegram',
    sdkMajor: 1,
    runtime: 'node',
    capabilities: {
      receive: true,
      transport: 'http',
      maxTextLength: 4000,
      lengthUnit: 'codepoint',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig: () => ({}),
    async setup(host) {
      channelHost = host
    },
    async send(input) {
      sent.push(input)
      return { status: 'sent', receipt: { platformMessageId: 'reply-1' } }
    }
  }

  const endpoints: EndpointConfig[] = configs.map((config, i) => ({
    id: `endpoint${i}`,
    agent,
    config,
    dispatchMode: push ? 'push' : 'pull'
  }))

  const config = {
    accounts: [
      { id: 'bot', channel: 'telegram', config: {}, allowedSenders: ['alice'] }
    ],
    endpoints,
    bindings: endpoints.map((e, i) => ({
      accountId: 'bot',
      chatId: `chat${i}`,
      endpointId: e.id
    })),
    storage: { plugin: 'sqlite', config: {} },
    observability: { plugin: 'none', config: {} }
  }

  const build = async (
    agentPlugin: AgentPlugin<unknown>
  ): Promise<CoreRuntime> =>
    createCore({
      config,
      storage,
      channels: new Map([['bot', channel]]),
      agents: new Map([[agent, agentPlugin]])
    })

  let core = await build(plugin)
  const clients: Client[] = []
  const wire: unknown[] = []
  return {
    endpoints,
    filename,
    sent,
    wire,
    get storage() {
      return storage
    },
    get core() {
      return core
    },
    get agent() {
      return currentPlugin
    },
    async ingest(
      endpoint = 0,
      text = '中文\nsecond line',
      event = 'event-1',
      attachments?: readonly MediaUpload[]
    ): Promise<IngestReceipt> {
      if (!channelHost) {
        throw new Error('channel_not_setup')
      }
      return channelHost.ingest({
        source: { channel: 'telegram', accountId: 'bot', eventId: event },
        senderId: 'alice',
        text,
        target: {
          channel: 'telegram',
          accountId: 'bot',
          chatId: `chat${endpoint}`,
          replyToId: 'original',
          data: { privateTarget: 'internal' }
        },
        receivedAt: Date.now(),
        context: { thread: 'protocol-context' },
        ...(attachments ? { attachments } : {})
      })
    },
    async client(
      token = 'secret-0',
      endpoint = 0,
      modern = agent === 'dot'
    ): Promise<Client> {
      const client = new Client(
        { name: 'protocol-test', version: '1.0.0' },
        modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
      )

      clients.push(client)
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://relanox.test/agents/${agent}/mcp/endpoint${endpoint}`
          ),
          {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
            fetch: async (input, init): Promise<Response> => {
              const response = await core.fetch(new Request(input, init))
              if (
                response.headers
                  .get('content-type')
                  ?.includes('application/json') === true
              ) {
                wire.push(await response.clone().json())
              }
              return response
            }
          }
        )
      )
      return client
    },
    async reopen(next: AgentPlugin<unknown>): Promise<void> {
      await currentPlugin.stop?.()
      await storage.close()
      storage = createSqliteStorage({ filename, busyTimeoutMs: 5000 })
      core = await build(next)
      currentPlugin = next
    },
    async close(): Promise<void> {
      await Promise.all(
        clients.map(async (client) => {
          try {
            await client.close()
          } catch {
            // A failed protocol client may already be closed.
          }
        })
      )
      await currentPlugin.stop?.()
      await storage.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export function mcp(token = 'AGENT_TEST_TOKEN_0'): {
  token: { env: string }
  allowedHosts: string[]
  allowedOrigins: never[]
  maxBodyBytes: number
  timeoutMs: number
} {
  return {
    token: { env: token },
    allowedHosts: ['relanox.test'],
    allowedOrigins: [],
    maxBodyBytes: 1_048_576,
    timeoutMs: 1000
  }
}
