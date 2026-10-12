import {
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'
import { createServer } from 'node:http'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { noopObservability } from '@relanox/sdk'
import type {
  ChannelHost,
  HttpHandler,
  IngestInput,
  SendInput
} from '@relanox/sdk'

export { createSqliteStorage } from '@relanox/storage-sqlite'
export { sessionSchema } from '../src/schemas.js'

export function recorder(ingest?: (input: IngestInput) => Promise<void>): {
  host: ChannelHost
  received: IngestInput[]
  handlers: Map<string, HttpHandler>
  connections: string[]
} {
  const received: IngestInput[] = []
  const handlers = new Map<string, HttpHandler>()
  const connections: string[] = []

  const unavailable = async (): Promise<never> => {
    throw new Error('state_unavailable')
  }

  const host: ChannelHost = {
    observe: noopObservability,
    state: {
      get: unavailable,
      list: unavailable,
      compareAndSet: unavailable,
      delete: unavailable
    },
    mountHttp(path, handler) {
      handlers.set(path, handler)
    },
    connection(status) {
      connections.push(status)
    },
    async ingest(input) {
      await ingest?.(input)
      received.push(input)
      return { requestId: 'request-1', duplicate: false }
    }
  }

  return { host, received, handlers, connections }
}

export type Captured = {
  path: string
  headers: IncomingHttpHeaders
  body: unknown
}

type PeerResponse = {
  status?: number
  headers?: Record<string, string>
  body: unknown
}

export async function peer(
  respond: (input: Captured) => PeerResponse
): Promise<{
  url: string
  requests: Captured[]
  discoveryRequests: Captured[]
  identity(this: void, value: Record<string, unknown>, status?: number): void
  server: ReturnType<typeof createServer>
  close(this: void): Promise<void>
}> {
  const requests: Captured[] = []
  const discoveryRequests: Captured[] = []
  let identityStatus = 200
  let identityOverride: Record<string, unknown> = {}

  async function handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      const value: unknown = chunk
      if (!Buffer.isBuffer(value)) {
        throw new TypeError('unexpected_peer_bytes')
      }
      chunks.push(value)
    }

    const body: unknown =
      chunks.length > 0
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : null

    const input: Captured = {
      path: (request.url ?? '').replace(/^\/api(?:\/v10)?(?=\/)/u, ''),
      headers: request.headers,
      body
    }

    let identity: PeerResponse | undefined
    if (input.path === '/users/@me') {
      identity = { body: { id: '999', bot: true, ...identityOverride } }
    }
    if (input.path === '/gateway/bot') {
      identity = { body: { url: 'wss://gateway.discord.gg' } }
    }

    if (identity) {
      discoveryRequests.push(input)
    } else {
      requests.push(input)
    }
    const output: PeerResponse = identity ?? respond(input)
    response.writeHead(identity ? identityStatus : (output.status ?? 200), {
      'content-type': 'application/json',
      ...output.headers
    })
    response.end(JSON.stringify(output.body))
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500)
      response.end()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const url = registerPeer(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  )

  routePlatform('https://discord.com', url)
  return {
    url,
    requests,
    discoveryRequests,
    identity: (value, status = 200) => {
      identityOverride = value
      identityStatus = status
    },
    server,
    close: async () => close(server)
  }
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export function sendInput(
  target: SendInput['target'],
  signal = new AbortController().signal
): SendInput {
  return {
    deliveryId: 'delivery-1',
    channelId: 'request-1',
    chunkIndex: 0,
    chunk: {
      text: '**hello** [link](https://example.com) @everyone <@U123>',
      idempotencyKey: '8db4f4f4-f32c-42a4-a53d-414e348f33a3:0',
      state: null
    },
    target,
    signal
  }
}
