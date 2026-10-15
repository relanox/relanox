import { listenPeer } from '../../../tests/listen.js'
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
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { beforeEach } from 'vitest'
import type { RequestOptions } from 'node:https'
import { noopObservability } from '@relanox/sdk'
import type {
  ChannelHost,
  HttpHandler,
  IngestInput,
  SendInput
} from '@relanox/sdk'

/** Axios uses the options-only native request overload; retain real HTTP peers. */
export function installSdkNetwork(): void {
  beforeEach(() => {
    const routed = https.request
    https.request = ((
      input: string | URL | RequestOptions,
      options: RequestOptions | ((response: IncomingMessage) => void),
      callback?: (response: IncomingMessage) => void
    ) => {
      if (typeof input === 'object' && !(input instanceof URL)) {
        const url = new URL(
          `https://${input.hostname ?? input.host}${input.port !== undefined && input.port !== '' ? `:${input.port}` : ''}${input.path ?? '/'}`
        )

        const {
          protocol: _protocol,
          hostname: _hostname,
          host: _host,
          path: _path,
          port: _port,
          agent: _agent,
          ...request
        } = input

        return routed(
          url,
          request,
          options as (response: IncomingMessage) => void
        )
      }
      return routed(input, options as RequestOptions, callback)
    }) as typeof https.request
    syncBuiltinESMExports()
  })
}

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
  disconnect?: boolean
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

    const body: unknown = request.headers['content-type']?.includes(
      'application/json'
    )
      ? JSON.parse(content || 'null')
      : content

    const input: Captured = {
      path: (request.url ?? '').replace(/^\/api(?:\/v10)?(?=\/)/u, ''),
      headers: request.headers,
      body
    }

    const identity: PeerResponse | undefined =
      input.path === '/open-apis/bot/v3/info'
        ? { body: { code: 0, bot: { open_id: 'ou_bot' }, ...identityOverride } }
        : undefined

    if (identity) {
      discoveryRequests.push(input)
    } else {
      requests.push(input)
    }
    if (identity && requests.at(-1)?.path.includes('tenant_access_token')) {
      const tokenRequest = requests.pop()
      if (tokenRequest) {
        discoveryRequests.push(tokenRequest)
      }
    }
    const output: PeerResponse = identity ?? respond(input)
    if (output.disconnect) {
      response.destroy()
      return
    }
    response.writeHead(identity ? identityStatus : (output.status ?? 200), {
      'content-type': 'application/json',
      ...output.headers
    })
    response.end(
      output.body instanceof Uint8Array
        ? output.body
        : JSON.stringify(output.body)
    )
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500)
      response.end()
    })
  })

  await listenPeer(server)

  const url = registerPeer(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  )

  routePlatform('https://open.feishu.cn', url)
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
