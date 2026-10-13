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
import type { WorkerOptions } from '@relanox/core'
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

type ContentResponse = {
  status: number
  data: Uint8Array
  mimeType: string
}

export async function peer(): Promise<{
  base: string
  traffic: Traffic[]
  identities: Traffic[]
  respond(
    this: void,
    code: number,
    body: Json,
    responseHeaders?: Record<string, string>
  ): void
  keys(this: void, value: Json): void
  identity(this: void, id: string): void
  identityResponse(this: void, status: number, body: Json): void
  content(this: void, ...responses: ContentResponse[]): void
  close(this: void): Promise<void>
}> {
  const traffic: Traffic[] = []
  const identities: Traffic[] = []
  let status = 200
  let output: Json = {}
  let headers: Record<string, string> = {}
  let jwks: Json = {}
  let identityBody: Json = { userId: 'bot' }
  let identityStatus = 200
  let contentResponses: ContentResponse[] = []

  async function receive(
    incoming: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const parts: Buffer[] = []
    for await (const part of incoming) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)))
    }
    const path = incoming.url ?? '/'
    if (path === '/v2/bot/info') {
      identities.push({
        path,
        body: Buffer.concat(parts).toString('utf8'),
        headers: incoming.headers
      })
      response.setHeader('content-type', 'application/json')
      response.writeHead(identityStatus)
      response.end(JSON.stringify(identityBody))
      return
    }
    traffic.push({
      path,
      body: Buffer.concat(parts).toString('utf8'),
      headers: incoming.headers
    })
    const contentResponse = contentResponses[0]
    if (contentResponse && path.endsWith('/content')) {
      if (contentResponses.length > 1) {
        contentResponses.shift()
      }
      response.writeHead(contentResponse.status, {
        'content-type': contentResponse.mimeType
      })
      response.end(contentResponse.data)
      return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/v1/.well-known/keys') {
      response.end(JSON.stringify(jwks))
      return
    }
    if (path === '/botframework.com/oauth2/v2.0/token') {
      response.end(
        JSON.stringify({ access_token: 'oauth-token', token_type: 'Bearer' })
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
  const base = 'https://api.line.me'
  const hosts = ['api.line.me', 'api-data.line.me', new URL(base).hostname]

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
    identities,
    respond(
      code: number,
      body: Json,
      responseHeaders: Record<string, string> = {}
    ): void {
      status = code
      output = body
      headers = responseHeaders
    },
    identity(id: string): void {
      identityBody = { userId: id }
      identityStatus = 200
    },
    identityResponse(code: number, body: Json): void {
      identityStatus = code
      identityBody = body
    },
    content(...responses: ContentResponse[]): void {
      contentResponses = responses
    },
    keys(value: Json): void {
      jwks = value
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
  worker?: WorkerOptions
): Promise<{
  core: Awaited<ReturnType<typeof createCore>>
  storage: ReturnType<typeof createSqliteStorage>
  dispatches: string[]
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
    publicUrl: 'https://relay.example',
    ...(worker ? { worker } : {}),
    storage,
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
  }).catch(async (error: unknown) => {
    await storage.close()
    throw error
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
    sendReply,
    async close(): Promise<void> {
      await storage.close()
    }
  }
}
