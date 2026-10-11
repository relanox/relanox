import { createServer } from 'node:http'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse
} from 'node:http'

export interface Traffic {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

export interface PeerReply {
  readonly status?: number
  readonly body?: unknown
  readonly dropConnection?: boolean
}

/** Simulates only the external HTTP service. Relanox owns all durable business behavior. */
export async function peer(
  reply: (traffic: Traffic, index: number) => PeerReply
) {
  const traffic: Traffic[] = []

  async function receive(request: IncomingMessage, response: ServerResponse) {
    const chunks: Uint8Array[] = []
    for await (const received of request) {
      const chunk: unknown = received
      if (!(chunk instanceof Uint8Array)) {
        throw new Error('unexpected_http_bytes')
      }
      chunks.push(chunk)
    }

    const record = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8')
    }

    traffic.push(record)
    const result = reply(record, traffic.length - 1)
    if (result.dropConnection === true) {
      response.destroy()
      return
    }
    response.writeHead(result.status ?? 200, {
      'Content-Type': 'application/json'
    })
    response.end(JSON.stringify(result.body ?? {}))
  }

  const server = createServer((request, response) => {
    void receive(request, response).catch(() => {
      response.destroy()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('missing_peer_address')
  }
  return {
    traffic,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
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

export async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('missing_reserved_port')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
  return address.port
}
