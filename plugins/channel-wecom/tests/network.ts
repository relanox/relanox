import https from 'node:https'
import dns from 'node:dns/promises'
import { syncBuiltinESMExports } from 'node:module'
import { request as httpRequest } from 'node:http'
import type {
  ClientRequest,
  RequestOptions,
  IncomingMessage,
  ClientRequestArgs
} from 'node:http'
import type { LookupAllOptions, LookupAddress } from 'node:dns'
import type { ClientOptions } from 'ws'
import { beforeEach, afterEach, vi } from 'vitest'

const routes = vi.hoisted(() => new Map<string, string>())
export const outboundRequests: string[] = []

const originalFetch = globalThis.fetch
const originalHttps = https.request
const originalLookup = dns.lookup

vi.mock(import('ws'), async (original) => {
  const actual = await original()

  class PeerWebSocket extends actual.WebSocket {
    constructor(address: null)
    constructor(
      address: string | URL,
      options?: ClientOptions | ClientRequestArgs
    )
    constructor(
      address: string | URL,
      protocols?: string | string[],
      options?: ClientOptions | ClientRequestArgs
    )
    constructor(
      address: string | URL | null,
      protocolsOrOptions?:
        string | string[] | ClientOptions | ClientRequestArgs,
      options?: ClientOptions | ClientRequestArgs
    ) {
      if (address === null) {
        super(null)
        return
      }

      const url = new URL(address)
      const mapped = routes.get(url.origin)

      const destination = mapped
        ? `${mapped}${url.pathname === '/' && new URL(mapped).pathname !== '/' ? '' : url.pathname}${url.search}`
        : address

      if (
        typeof protocolsOrOptions === 'string' ||
        Array.isArray(protocolsOrOptions)
      ) {
        super(destination, protocolsOrOptions, options)
      } else {
        super(destination, protocolsOrOptions)
      }
    }
  }

  return { ...actual, WebSocket: PeerWebSocket, default: PeerWebSocket }
})

function publicPath(url: URL): string {
  return ['slack.com', 'discord.com'].includes(url.hostname)
    ? url.pathname.replace(/^\/api(?:\/v10)?(?=\/)/u, '')
    : url.pathname
}

function httpsPeerRequest(
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void
): ClientRequest {
  const mapped = routes.get(url.origin)

  return mapped
    ? httpRequest(
        new URL(`${mapped}${publicPath(url)}${url.search}`),
        { ...options, lookup: undefined },
        callback
      )
    : originalHttps(url, options, callback)
}

async function peerLookup(
  hostname: string,
  options: LookupAllOptions
): Promise<LookupAddress[]> {
  if (routes.has(`https://${hostname}`)) {
    return [{ address: '93.184.216.34', family: 4 }]
  }

  return originalLookup(hostname, options)
}

export function installPeerNetwork(): void {
  beforeEach(() => {
    routes.clear()
    outboundRequests.length = 0
    https.request = httpsPeerRequest as typeof https.request
    dns.lookup = peerLookup as typeof dns.lookup
    syncBuiltinESMExports()
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const mapped = routes.get(url.origin)
        if (mapped) {
          outboundRequests.push(url.href)
        }

        const destination = mapped
          ? new URL(`${mapped}${publicPath(url)}${url.search}`)
          : input

        return originalFetch(
          input instanceof Request && mapped
            ? new Request(destination, input)
            : destination,
          init
        )
      }
    )
  })

  afterEach(() => {
    https.request = originalHttps
    dns.lookup = originalLookup
    syncBuiltinESMExports()
  })
}

/** Present a public peer URL while the network boundary records real local traffic. */
export function registerPeer(local: string): string {
  const endpoint = new URL(local)
  const publicOrigin = `https://peer-${endpoint.port}.example`

  routes.set(publicOrigin, endpoint.origin)
  routes.set(
    publicOrigin.replace('https:', 'wss:'),
    endpoint.origin.replace('http:', 'ws:')
  )

  return publicOrigin
}

export function routePlatform(platform: string, peer: string): void {
  const publicPeer = new URL(peer)
  const destination = routes.get(publicPeer.origin)

  if (!destination) {
    throw new Error('unknown_protocol_peer')
  }

  routes.set(
    new URL(platform).origin,
    platform.startsWith('wss:')
      ? `${destination.replace('http:', 'ws:')}${publicPeer.pathname.replace(/\/$/u, '')}`
      : destination
  )
}
