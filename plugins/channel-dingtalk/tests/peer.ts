import { listenPeer } from '../../../tests/listen.js'
import { afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { registerPeer, routePlatform } from './network.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
})

export type HttpRequest = {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: unknown
}

export type HttpReply = {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: unknown
  readonly disconnect?: boolean
}

export async function peer(
  handle: (request: HttpRequest) => HttpReply | Promise<HttpReply>,
  connected: (socket: WebSocket) => void = () => {}
): Promise<{
  requests: HttpRequest[]
  frames: unknown[]
  sockets: WebSocket[]
  http: string
  ws: string
}> {
  const requests: HttpRequest[] = []
  const frames: unknown[] = []
  const sockets: WebSocket[] = []

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const chunks: Buffer[] = []
      for await (const part of request as AsyncIterable<unknown>) {
        if (!Buffer.isBuffer(part)) {
          throw new TypeError('Unexpected HTTP chunk')
        }
        chunks.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength))
      }
      const raw = Buffer.concat(chunks)
      const bytes = raw.toString()
      let body: unknown = null
      if (bytes) {
        body = request.headers['content-type']?.includes('application/json')
          ? (JSON.parse(bytes) as unknown)
          : raw
      }

      const input = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body
      }

      requests.push(input)
      const reply = await handle(input)
      if (reply.disconnect) {
        request.socket.destroy()
        return
      }
      response.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...reply.headers
      })
      response.end(
        Buffer.isBuffer(reply.body)
          ? reply.body
          : JSON.stringify(reply.body ?? {})
      )
    })().catch(() => {
      response.writeHead(500)
      response.end()
    })
  })

  const ws = new WebSocketServer({ server })
  ws.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      if (!Buffer.isBuffer(data)) {
        throw new TypeError('unexpected_peer_frame')
      }

      frames.push(JSON.parse(data.toString('utf8')) as unknown)
    })
    connected(socket)
  })
  await listenPeer(server)
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Missing local peer address')
  }
  const publicOrigin = registerPeer(`http://127.0.0.1:${address.port}`)
  for (const origin of [
    'https://api.dingtalk.com',
    'https://oapi.dingtalk.com'
  ]) {
    routePlatform(origin, publicOrigin)
  }
  cleanup.push(async () => {
    for (const socket of sockets) {
      socket.terminate()
    }
    await new Promise<void>((resolve) => {
      ws.close(() => {
        resolve()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  })
  return {
    requests,
    frames,
    sockets,
    http: publicOrigin,
    ws: publicOrigin.replace('https:', 'wss:')
  }
}
