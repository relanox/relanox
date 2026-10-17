import type { Hono } from 'hono'
import type { HttpHandler, Observability, HttpRouteOptions } from '@relanox/sdk'
import type { WorkerConfig } from './worker/options.js'
import { CoreError } from './errors.js'

/** Owns inbound body limits, cancellation, response mapping, and HTTP duration. */
export function createHttpHandler(
  app: Hono,
  worker: WorkerConfig,
  observe: Observability,
  routes: ReadonlyMap<string, HttpRouteOptions> = new Map()
): HttpHandler {
  return async (request: Request): Promise<Response> => {
    const start = Date.now()
    try {
      const path = new URL(request.url).pathname

      const route = [...routes].find(([pattern]) =>
        pattern.endsWith('*')
          ? path.startsWith(pattern.slice(0, -1))
          : path === pattern
      )?.[1]

      const denied = await route?.authorize(request)
      if (denied) {
        void request.body?.cancel().catch(() => {})
        return denied
      }
      return await app.fetch(
        await boundedRequest(
          request,
          route?.maxBodyBytes ?? worker.maxHttpBodyBytes,
          worker.callTimeoutMs
        )
      )
    } catch (error) {
      const code = error instanceof CoreError ? error.code : 'invalid_request'
      let status = 400
      if (code === 'body_too_large') {
        status = 413
      } else if (code === 'request_timeout') {
        status = 408
      }
      return Response.json({ error: code }, { status })
    } finally {
      observe.record(
        'relanox_http_duration_seconds',
        (Date.now() - start) / 1000,
        {
          operation: 'http'
        }
      )
    }
  }
}

async function boundedRequest(
  request: Request,
  maximum: number,
  timeoutMs: number
): Promise<Request> {
  if (request.signal.aborted) {
    void request.body?.cancel().catch(() => {})
    throw new CoreError('request_timeout')
  }
  if (!request.body) {
    return request
  }
  const reader = request.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const chunks: Uint8Array[] = []
  let size = 0

  const read = async (): Promise<Request> => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > maximum) {
        throw new CoreError('body_too_large')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new Request(request, { method: request.method, body: bytes })
  }

  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        onAbort = (): void => {
          reject(new CoreError('request_timeout'))
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => {
          reject(new CoreError('request_timeout'))
        }, timeoutMs)
      })
    ])
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    if (onAbort) {
      request.signal.removeEventListener('abort', onAbort)
    }
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export function createHttpRoutes(): Map<string, HttpRouteOptions> {
  return new Map()
}
