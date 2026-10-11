import { createServer } from 'node:http'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { createCore } from '@relanox/core'
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

export type Traffic = {
  path: string
  body: string
  headers: IncomingHttpHeaders
}

export async function peer(): Promise<{
  base: string
  traffic: Traffic[]
  disconnectOnce(this: void, path: string): void
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
  keys(this: void, value: Json): void
  close(this: void): Promise<void>
}> {
  const traffic: Traffic[] = []
  const disconnects = new Set<string>()

  const routes = new Map<
    string,
    { status: number; body: Json | Uint8Array; headers: Record<string, string> }
  >()

  let status = 200
  let output: Json = {}
  let headers: Record<string, string> = {}
  let jwks: Json = {}
  let tokenStatus = 200
  let tokenBody: Json = { access_token: 'oauth-token', token_type: 'Bearer' }

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
    if (disconnects.delete(path)) {
      response.destroy()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/keys') {
      response.end(JSON.stringify(jwks))
      return
    }
    if (path === '/token') {
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
  return {
    base: `http://127.0.0.1:${address.port}`,
    traffic,
    disconnectOnce(path: string): void {
      disconnects.add(path)
    },
    route(
      path: string,
      body: Json | Uint8Array,
      routeHeaders: Record<string, string> = {},
      code = 200
    ): void {
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
    keys(value: Json): void {
      jwks = value
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

export async function harness(
  plugin: ChannelPlugin<unknown>,
  config: Json,
  chat: string,
  sender: string,
  thread?: string,
  filename = ':memory:',
  publicBaseUrl?: string
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
  const storage = createSqliteStorage({ filename, busyTimeoutMs: 5000 })
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
    ...(publicBaseUrl
      ? { media: { publicBaseUrl, allowInsecureLocalhost: true } }
      : {}),
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
      replyTo: item.requestId,
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
