import https from 'node:https'
import dns from 'node:dns/promises'
import { request as httpRequest, createServer } from 'node:http'
import type { LookupAllOptions } from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'

import type {
  RequestOptions,
  IncomingMessage as HttpResponse,
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { createCore } from '@relanox/core'
import type { CoreOptions, CoreRuntime } from '@relanox/core'
import type {
  AgentHost,
  AgentPlugin,
  ChannelPlugin,
  Json,
  ScopedAgentHost,
  InboundSnapshot,
  OutboundRecord
} from '@relanox/sdk'
import { createSqliteStorage } from '@relanox/storage-sqlite'

const transport = {
  destinations: new Map<string, string>(),
  fetch: globalThis.fetch,
  request: https.request,
  lookup: dns.lookup
}

function interceptMedia(): void {
  https.request = ((
    url: URL,
    options: RequestOptions,
    callback: (response: HttpResponse) => void
  ) => {
    const destination = transport.destinations.get(url.hostname)
    if (!destination) {
      return transport.request(url, options, callback)
    }
    const local = new URL(url.pathname + url.search, destination)
    return httpRequest(local, { ...options, lookup: undefined }, callback)
  }) as typeof https.request
  dns.lookup = (async (hostname: string, options: LookupAllOptions) => {
    if (transport.destinations.has(hostname)) {
      return [{ address: '203.0.113.1', family: 4 }]
    }
    return transport.lookup(hostname, options)
  }) as typeof dns.lookup
  syncBuiltinESMExports()
}

export type Traffic = {
  path: string
  body: string
  headers: IncomingHttpHeaders
}

export async function peer(): Promise<{
  base: string
  traffic: Traffic[]
  route(
    this: void,
    path: string,
    body: Json | Uint8Array,
    routeHeaders?: Record<string, string>,
    code?: number
  ): void
  respond(
    this: void,
    code: number,
    body: Json,
    responseHeaders?: Record<string, string>
  ): void
  token(this: void, code: number, body: Json): void
  holdToken(this: void): () => void
  keys(this: void, value: Json): void
  disconnect(this: void, path: string): void
  close(this: void): Promise<void>
}> {
  const traffic: Traffic[] = []
  const disconnected = new Set<string>()

  const routes = new Map<
    string,
    { status: number; body: Json | Uint8Array; headers: Record<string, string> }
  >()

  let status = 200
  let output: Json = {}
  let headers: Record<string, string> = {}
  let jwks: Json = {}
  let tokenStatus = 200
  let tokenWait: Promise<void> | undefined

  // Google service-account OAuth responses include their lifetime in seconds:
  // https://developers.google.com/identity/protocols/oauth2/service-account#httprest_2
  let tokenBody: Json = {
    access_token: 'oauth-token',
    token_type: 'Bearer',
    expires_in: 3600
  }

  async function receive(
    incoming: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const parts: Buffer[] = []
    for await (const part of incoming) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)))
    }
    const path = incoming.url ?? '/'
    traffic.push({
      path,
      body: Buffer.concat(parts).toString('utf8'),
      headers: incoming.headers
    })
    if (disconnected.has(path)) {
      response.destroy()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/oauth2/v1/certs') {
      response.end(JSON.stringify(jwks))
      return
    }
    if (path === '/token') {
      await tokenWait
      response.writeHead(tokenStatus)
      response.end(JSON.stringify(tokenBody))
      return
    }
    const route = routes.get(path)
    if (route) {
      response.writeHead(route.status, route.headers)
      response.end(
        route.body instanceof Uint8Array
          ? route.body
          : JSON.stringify(route.body)
      )
      return
    }
    response.writeHead(status, headers)
    response.end(JSON.stringify(output))
  }

  const server = createServer((incoming, response) => {
    void receive(incoming, response).catch(() => {
      response.destroy()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  interceptMedia()
  const destination = `http://127.0.0.1:${address.port}`
  const base = 'https://chat.googleapis.com'

  const hosts = [
    'chat.googleapis.com',
    'www.googleapis.com',
    'oauth2.googleapis.com',
    new URL(base).hostname
  ]

  for (const host of hosts) {
    transport.destinations.set(host, destination)
  }
  globalThis.fetch = async (input, init): Promise<Response> => {
    const requested = new URL(input instanceof Request ? input.url : input)
    const mapped = transport.destinations.get(requested.hostname)
    if (!mapped) {
      return transport.fetch(input, init)
    }
    const local = new URL(requested.pathname + requested.search, mapped)
    return transport.fetch(
      input instanceof Request ? new Request(local, input) : local,
      init
    )
  }
  return {
    base,
    traffic,
    route(
      path: string,
      body: Json | Uint8Array,
      routeHeaders: Record<string, string> = {},
      code = 200
    ): void {
      disconnected.delete(path)
      routes.set(path, { status: code, body, headers: routeHeaders })
    },
    respond(
      code: number,
      body: Json,
      responseHeaders: Record<string, string> = {}
    ): void {
      status = code
      output = body
      headers = responseHeaders
    },
    token(code: number, body: Json): void {
      tokenStatus = code
      tokenBody = body
    },
    holdToken(): () => void {
      let release: () => void = () => {}
      tokenWait = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    },
    keys(value: Json): void {
      jwks = value
    },
    disconnect(path: string): void {
      disconnected.add(path)
    },
    async close(): Promise<void> {
      for (const host of hosts) {
        if (transport.destinations.get(host) === destination) {
          transport.destinations.delete(host)
        }
      }
      if (transport.destinations.size === 0) {
        globalThis.fetch = transport.fetch
        https.request = transport.request
        dns.lookup = transport.lookup
        syncBuiltinESMExports()
      }
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
  }
}

export async function harness(
  plugin: ChannelPlugin<unknown>,
  config: Json,
  chat: string,
  sender: string,
  thread?: string,
  filename = ':memory:',
  publicUrl?: string,
  worker?: CoreOptions['worker']
): Promise<{
  core: Awaited<ReturnType<typeof createCore>>
  storage: ReturnType<typeof createSqliteStorage>
  dispatches: string[]
  principal(this: void): ScopedAgentHost
  sendReply(
    this: void,
    text?: string
  ): Promise<{
    request: InboundSnapshot
    delivery: OutboundRecord | undefined
  }>
  close(this: void): Promise<void>
}> {
  const storage = createSqliteStorage({ filename })
  await storage.initialize()
  let host: AgentHost | undefined
  const dispatches: string[] = []

  const agent: AgentPlugin = {
    id: 'agent-dot',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'agent',
    agent: 'dot',
    validateConfig(value) {
      return value as Json
    },
    async setup(value) {
      host = value
    },
    async dispatch(input) {
      dispatches.push(input.request.text)
      return { status: 'accepted' }
    }
  }

  const core = await createCore({
    publicUrl: publicUrl ?? 'https://relay.example',
    storage,
    ...(worker ? { worker } : {}),
    channels: new Map([['business', plugin]]),
    agents: new Map([['dot', agent]]),
    config: {
      accounts: [
        {
          id: 'business',
          channel: plugin.channel,
          config,
          allowedSenders: [sender]
        }
      ],
      endpoints: [{ id: 'agent', agent: 'dot', config: {} }],
      bindings: [
        {
          accountId: 'business',
          chatId: chat,
          ...(thread ? { threadId: thread } : {}),
          endpointId: 'agent'
        }
      ],
      storage: { plugin: 'sqlite', config: {} },
      observability: { plugin: 'none', config: {} }
    }
  })

  function principal(): ScopedAgentHost {
    if (!host) {
      throw new Error('Agent not installed')
    }
    return host.forPrincipal({ subject: 'local-agent', endpointIds: ['agent'] })
  }

  async function sendReply(text = 'answer'): Promise<{
    request: InboundSnapshot
    delivery: OutboundRecord | undefined
  }> {
    await core.processDue()
    const scoped = principal()

    const pending = (await storage.listInbound({ limit: 10 })).map(
      (record) => record.snapshot
    )

    const item = pending[0]
    if (!item) {
      throw new Error('No pending inbound')
    }

    const completion = await scoped.sendMessage({
      channel: item.channel.id,
      idempotencyKey: 'local-result',
      text
    })

    if (completion.status !== 'queued') {
      throw new Error('Completion failed')
    }
    await core.processDue()
    return {
      request: item,
      delivery: await storage.getOutbound(completion.deliveryId)
    }
  }

  return {
    core,
    storage,
    dispatches,
    principal,
    sendReply,
    async close(): Promise<void> {
      await storage.close()
    }
  }
}

/** Forward real callback HTTP traffic to the public core boundary. */
export async function webhook(core: CoreRuntime): Promise<{
  post(this: void, incoming: Request): Promise<Response>
  close(this: void): Promise<void>
}> {
  async function receive(
    incoming: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const parts: Buffer[] = []
    for await (const part of incoming) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)))
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) {
        headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
    }

    const result = await core.fetch(
      new Request(`http://local${incoming.url ?? '/'}`, {
        method: 'POST',
        headers,
        body: Buffer.concat(parts).toString('utf8')
      })
    )

    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(new Uint8Array(await result.arrayBuffer()))
  }

  const server = createServer((incoming, response) => {
    void receive(incoming, response).catch(() => response.destroy())
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    async post(incoming): Promise<Response> {
      return transport.fetch(
        `http://127.0.0.1:${address.port}${new URL(incoming.url).pathname}`,
        {
          method: 'POST',
          headers: incoming.headers,
          body: await incoming.text()
        }
      )
    },
    async close(): Promise<void> {
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
  }
}
