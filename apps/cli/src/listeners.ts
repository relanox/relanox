import { createServer } from 'node:http'
import type { Server, ServerOptions } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import type { CoreRuntime } from '@relanox/core'
import type { ObservabilityRuntime } from '@relanox/sdk'

function nodeServer(
  options: ServerOptions,
  listener: ReturnType<typeof getRequestListener>
): Server {
  return createServer(options, (request, response) => {
    void listener(request, response).catch(() => {
      response.destroy()
    })
  })
}

/** The adapter's lightweight request lacks native Request slots; reconstruct without buffering bytes. */
function nativeRequest(request: Request): Request {
  const init = {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    ...(request.body === null
      ? {}
      : { body: request.body, duplex: 'half' as const })
  }

  return new Request(request.url, init)
}

export async function listen(
  server: Server,
  port: number,
  host: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('listener_address_unavailable'))
        return
      }

      const hostname =
        address.family === 'IPv6' ? `[${address.address}]` : address.address

      resolve(`http://${hostname}:${address.port}`)
    })
  })
}

export async function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve()
    })
    server.closeIdleConnections()
  })
}

export function createListeners(
  core: CoreRuntime,
  observability: ObservabilityRuntime,
  live: () => boolean,
  workerHealthy: () => boolean
): {
  business: ReturnType<typeof nodeServer>
  management: ReturnType<typeof nodeServer>
} {
  const business = nodeServer(
    { requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 },
    getRequestListener(async (request) => core.fetch(nativeRequest(request)), {
      overrideGlobalObjects: false,
      errorHandler: () => new Response(null, { status: 500 })
    })
  )

  const management = nodeServer(
    { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 },
    getRequestListener(
      async (request) => {
        if (request.method !== 'GET') {
          return new Response(null, { status: 405 })
        }
        const path = new URL(request.url).pathname
        if (path === '/health/live') {
          const ok = live()
          return Response.json({ ok }, { status: ok ? 200 : 503 })
        }
        if (path === '/health/ready') {
          const ready = await core.readiness()
          const ok = ready.ok && live() && workerHealthy()
          return Response.json({ ok }, { status: ok ? 200 : 503 })
        }
        if (path === '/metrics' && observability.metrics) {
          try {
            return await observability.metrics(request)
          } catch {
            return new Response(null, { status: 503 })
          }
        }
        return new Response(null, { status: 404 })
      },
      {
        overrideGlobalObjects: false,
        errorHandler: () => new Response(null, { status: 500 })
      }
    )
  )

  return { business, management }
}
