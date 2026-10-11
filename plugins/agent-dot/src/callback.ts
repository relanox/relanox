import { isPublicAddress } from '@relanox/transport'

import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

export { isPublicAddress } from '@relanox/transport'

export class CallbackError extends Error {
  constructor(
    readonly reason:
      | 'forbidden_destination'
      | 'timeout'
      | 'network_error'
      | 'response_too_large'
  ) {
    super(reason)
    this.name = 'CallbackError'
  }
}

export function callbackUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.origin !== 'https://connectors.api.openai.com'
  ) {
    throw new CallbackError('forbidden_destination')
  }
  return url
}

/** Resolve immediately before connecting and pin that address; TLS still verifies the original hostname. */
export async function postCallback(
  urlValue: string,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  responseMode: 'body' | 'headers'
): Promise<{
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}> {
  const url = callbackUrl(urlValue)
  const hostname = url.hostname.replaceAll(/^\[|\]$/gu, '')
  const bound = AbortSignal.any([signal, AbortSignal.timeout(10_000)])

  async function resolveAddresses(): Promise<LookupAddress[]> {
    let onAbort: (() => void) | undefined

    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => {
        reject(new CallbackError('timeout'))
      }
      if (bound.aborted) {
        onAbort()
      } else {
        bound.addEventListener('abort', onAbort, { once: true })
      }
    })

    try {
      return await Promise.race([
        lookup(hostname, { all: true, order: 'verbatim' }),
        aborted
      ])
    } catch (error) {
      if (error instanceof CallbackError) {
        throw error
      }
      throw new CallbackError('network_error')
    } finally {
      if (onAbort !== undefined) {
        bound.removeEventListener('abort', onAbort)
      }
    }
  }

  const addresses =
    isIP(hostname) === 0
      ? await resolveAddresses()
      : [{ address: hostname, family: isIP(hostname) }]

  if (
    addresses.length === 0 ||
    addresses.some((resolved) => !isPublicAddress(resolved.address))
  ) {
    throw new CallbackError('forbidden_destination')
  }
  const address = addresses[0]
  if (!address) {
    throw new CallbackError('forbidden_destination')
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(body))
        },
        signal: bound,
        agent: false,
        lookup: (_host, options, done) => {
          if (options.all === true) {
            done(null, [{ address: address.address, family: address.family }])
          } else {
            done(null, address.address, address.family)
          }
        }
      },
      (res) => {
        res.on('error', () => {
          reject(new CallbackError(bound.aborted ? 'timeout' : 'network_error'))
        })
        if (responseMode === 'headers') {
          resolve({
            status: res.statusCode ?? 500,
            body: '',
            headers: res.headers
          })
          res.destroy()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 16_384) {
            res.destroy()
            reject(new CallbackError('response_too_large'))
          } else {
            chunks.push(chunk)
          }
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers
          })
        })
      }
    )

    req.on('error', () => {
      reject(new CallbackError(bound.aborted ? 'timeout' : 'network_error'))
    })
    req.end(body)
  })
}
