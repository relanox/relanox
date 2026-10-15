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

// The official WebClient uses application/x-www-form-urlencoded, with structured
// Arguments serialized as JSON: node-slack-sdk packages/web-api/src/WebClient.ts.
function formBody(content: string): Record<string, unknown> {
  return Object.fromEntries(
    Array.from(new URLSearchParams(content), ([key, value]) => [
      key,
      ['blocks', 'files'].includes(key) || value === 'true' || value === 'false'
        ? (JSON.parse(value) as unknown)
        : value
    ])
  )
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

    const content = Buffer.concat(chunks).toString('utf8')

    const type = request.headers['content-type'] ?? ''

    let body: unknown = content
    if (type.includes('application/json')) {
      body = JSON.parse(content || 'null')
    } else if (type.includes('application/x-www-form-urlencoded')) {
      body = formBody(content)
    }

    const input: Captured = {
      path: (request.url ?? '').replace(/^\/api(?:\/v10)?(?=\/)/u, ''),
      headers: request.headers,
      body
    }

    const identity: PeerResponse | undefined =
      input.path === '/auth.test'
        ? {
            body: {
              ok: true,
              team_id: 'T1',
              user_id: 'UBOT',
              bot_id: 'B1',
              ...identityOverride
            }
          }
        : undefined

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

  routePlatform('https://slack.com', url)
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
      text: 'hello @everyone <@U123>',
      idempotencyKey: '8db4f4f4-f32c-42a4-a53d-414e348f33a3:0',
      state: null
    },
    target,
    signal
  }
}
