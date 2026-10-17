import https from 'node:https'
import dns from 'node:dns/promises'
import { syncBuiltinESMExports } from 'node:module'
import { request as httpRequest } from 'node:http'
import type { ClientRequest, RequestOptions, IncomingMessage } from 'node:http'
import type { LookupAllOptions, LookupAddress } from 'node:dns'
import { beforeEach, afterEach, vi } from 'vitest'

const routes = new Map<string, string>()

const originalFetch = globalThis.fetch
const originalHttps = https.request
const originalLookup = dns.lookup

function httpsPeerRequest(
  input: URL | RequestOptions,
  options?: RequestOptions | ((response: IncomingMessage) => void),
  callback?: (response: IncomingMessage) => void
): ClientRequest {
  const respond = typeof options === 'function' ? options : callback

  const url =
    input instanceof URL
      ? input
      : new URL(
          input.path ?? '/',
          `https://${String(input.hostname ?? input.host)}`
        )

  const mapped = routes.get(url.origin)
  const forwardingOptions = typeof options === 'function' ? {} : (options ?? {})
  if (!mapped) {
    return input instanceof URL
      ? originalHttps(input, forwardingOptions, respond)
      : originalHttps(input, respond)
  }
  const forwarded = input instanceof URL ? forwardingOptions : input

  const {
    agent: _agent,
    createConnection: _createConnection,
    hostname: _hostname,
    host: _host,
    path: _path,
    port: _port,
    protocol: _protocol,
    ...rest
  } = forwarded

  return httpRequest(
    new URL(`${mapped}${url.pathname}${url.search}`),
    { ...rest, lookup: undefined },
    respond
  )
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
    https.request = httpsPeerRequest as typeof https.request
    dns.lookup = peerLookup as typeof dns.lookup
    syncBuiltinESMExports()
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const mapped = routes.get(url.origin)

        const destination = mapped
          ? new URL(`${mapped}${url.pathname}${url.search}`)
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
