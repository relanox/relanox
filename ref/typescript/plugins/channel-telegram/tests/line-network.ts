import https from 'node:https'
import dns from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import type { RequestOptions, IncomingMessage } from 'node:http'
import type { LookupAllOptions } from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'

/** Redirect only LINE's platform sockets to a real external HTTP peer. */
export function connectLinePeer(base: string): () => Promise<void> {
  const previousFetch = globalThis.fetch
  const previousRequest = https.request
  const previousLookup = dns.lookup

  const hosted = (hostname: string): boolean =>
    ['api.line.me', 'api-data.line.me'].includes(hostname)

  globalThis.fetch = async (input, init): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (!hosted(url.hostname)) {
      return previousFetch(input, init)
    }
    const local = new URL(url.pathname + url.search, base)
    return previousFetch(
      input instanceof Request ? new Request(local, input) : local,
      init
    )
  }
  https.request = ((
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void
  ) => {
    if (!hosted(url.hostname)) {
      return previousRequest(url, options, callback)
    }
    return httpRequest(
      new URL(url.pathname + url.search, base),
      { ...options, lookup: undefined },
      callback
    )
  }) as typeof https.request
  dns.lookup = (async (hostname: string, options: LookupAllOptions) => {
    if (hosted(hostname)) {
      return [{ address: '203.0.113.1', family: 4 }]
    }
    return previousLookup(hostname, options)
  }) as typeof dns.lookup
  syncBuiltinESMExports()
  return async (): Promise<void> => {
    globalThis.fetch = previousFetch
    https.request = previousRequest
    dns.lookup = previousLookup
    syncBuiltinESMExports()
  }
}
