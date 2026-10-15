import { listenPeer } from '../../../tests/listen.js'
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
import type { CoreOptions } from '@relanox/core'
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
    url: URL | RequestOptions,
    options?: RequestOptions | ((response: HttpResponse) => void),
    callback?: (response: HttpResponse) => void
  ) => {
    const respond = typeof options === 'function' ? options : callback

    const address =
      url instanceof URL
        ? url
        : new URL(
            url.path ?? '/',
            `https://${String(url.hostname ?? url.host)}`
          )

    const destination = transport.destinations.get(address.hostname)
    if (!destination) {
      return url instanceof URL
        ? transport.request(
            url,
            typeof options === 'function' ? {} : (options ?? {}),
            respond
          )
        : transport.request(url, respond)
    }
    const local = new URL(address.pathname + address.search, destination)

    let optionsToForward: RequestOptions = url instanceof URL ? {} : url
    if (url instanceof URL && typeof options !== 'function') {
      optionsToForward = options ?? {}
    }

    const {
      agent: _agent,
      hostname: _hostname,
      host: _host,
      path: _path,
      port: _port,
      protocol: _protocol,
      ...forwarded
    } = optionsToForward

    return httpRequest(local, { ...forwarded, lookup: undefined }, respond)
  }) as typeof https.request
  dns.lookup = (async (hostname: string, options: LookupAllOptions) => {
    if (transport.destinations.has(hostname)) {
      return [{ address: '203.0.113.1', family: 4 }]
    }
    return transport.lookup(hostname, options)
  }) as typeof dns.lookup
  syncBuiltinESMExports()
}

// The SDK's JsonWebToken consumes the JWT returned by MSAL, rather than a
// Fabricated opaque string: @microsoft/teams.api 2.1.0 auth/json-web-token.
export function oauthToken(label: string): string {
  const payload = {
    appid: 'app-id',
    aud: 'https://api.botframework.com',
    label,
    exp: Math.floor(Date.now() / 1000) + 3600
  }

  return `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

export type Traffic = {
  path: string
  body: string
  headers: IncomingHttpHeaders
}

export async function peer(): Promise<{
  base: string
  defaultToken: string
  traffic: Traffic[]
  disconnectOnce(this: void, path: string): void
  route(
    this: void,
    path: string,
    body: Json | Uint8Array | ((traffic: Traffic) => Json),
    routeHeaders?: Record<string, string>,
    code?: number | ((traffic: Traffic) => number)
  ): void
  respond(
    this: void,
    code: number,
    body: Json,
    responseHeaders?: Record<string, string>
  ): void
  token(
    this: void,
    code: number,
    body: Json,
    responseHeaders?: Record<string, string>
  ): void
  holdToken(this: void): () => void
  keys(this: void, value: Json): void
  close(this: void): Promise<void>
}> {
  const traffic: Traffic[] = []
  const disconnects = new Set<string>()

  const routes = new Map<
    string,
    {
      status: number | ((traffic: Traffic) => number)
      body: Json | Uint8Array | ((traffic: Traffic) => Json)
      headers: Record<string, string>
    }
  >()

  let status = 200
  let output: Json = {}
  let headers: Record<string, string> = {}
  let jwks: Json = {}
  let tokenStatus = 200
  let tokenHeaders: Record<string, string> = {}

  // Bot Connector OAuth documents the lifetime in seconds:
  // https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
  const defaultToken = oauthToken('oauth-token')

  let tokenBody: Json = {
    access_token: defaultToken,
    token_type: 'Bearer',
    expires_in: 3600
  }

  let tokenWait: Promise<void> | undefined

  async function receive(
    incoming: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const parts: Buffer[] = []
    for await (const part of incoming) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)))
    }
    const path = new URL(incoming.url ?? '/', 'http://peer').pathname

    const requestEntry: Traffic = {
      path,
      body: Buffer.concat(parts).toString('utf8'),
      headers: incoming.headers
    }

    traffic.push(requestEntry)
    if (disconnects.delete(path)) {
      response.destroy()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/v1/.well-known/keys') {
      response.end(JSON.stringify(jwks))
      return
    }
    // Entra authority metadata consumed by the real MSAL library:
    // https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
    if (path.includes('/.well-known/openid-configuration')) {
      const tenant = path.split('/')[1]
      response.end(
        JSON.stringify({
          authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
          token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
          issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
          jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
          end_session_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/logout`
        })
      )
      return
    }
    if (path === '/botframework.com/oauth2/v2.0/token') {
      await tokenWait
      response.writeHead(tokenStatus, tokenHeaders)
      response.end(JSON.stringify(tokenBody))
      return
    }
    const route = routes.get(path)
    if (route) {
      response.writeHead(
        typeof route.status === 'function'
          ? route.status(requestEntry)
          : route.status,
        route.headers
      )

      const body =
        typeof route.body === 'function' ? route.body(requestEntry) : route.body

      response.end(body instanceof Uint8Array ? body : JSON.stringify(body))
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

  await listenPeer(server)
  const address = server.address() as AddressInfo
  interceptMedia()
  const destination = `http://127.0.0.1:${address.port}`
  const base = `https://${address.port}.teams.test`

  const hosts = [
    'login.botframework.com',
    'login.microsoftonline.com',
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
    defaultToken,
    traffic,
    disconnectOnce(path: string): void {
      disconnects.add(path)
    },
    route(
      path: string,
      body: Json | Uint8Array | ((traffic: Traffic) => Json),
      routeHeaders: Record<string, string> = {},
      code: number | ((traffic: Traffic) => number) = 200
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
    token(
      code: number,
      body: Json,
      responseHeaders: Record<string, string> = {}
    ): void {
      tokenStatus = code
      tokenBody = body
      tokenHeaders = responseHeaders
    },
    holdToken(): () => void {
      let release = (): void => {}
      tokenWait = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
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
