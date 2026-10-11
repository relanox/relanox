import { createServer } from 'node:http'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse
} from 'node:http'

export type MediaTraffic = {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly data: Uint8Array
}

export type MediaReply = {
  readonly status?: number
  readonly json?: unknown
  readonly data?: Uint8Array
  readonly mimeType?: string
  readonly drop?: boolean
}

export async function mediaPeer(
  reply: (traffic: MediaTraffic) => MediaReply
): Promise<{
  origin: string
  traffic: MediaTraffic[]
  close(this: void): Promise<void>
}> {
  const traffic: MediaTraffic[] = []

  async function receive(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const chunks: Uint8Array[] = []
    for await (const part of request) {
      const value: unknown = part
      if (!(value instanceof Uint8Array)) {
        throw new Error('invalid_peer_bytes')
      }
      chunks.push(value)
    }

    const item = {
      method: request.method ?? '',
      path: request.url ?? '',
      headers: request.headers,
      data: Buffer.concat(chunks)
    }

    traffic.push(item)
    const result = reply(item)
    if (result.drop) {
      response.destroy()
      return
    }
    response.writeHead(result.status ?? 200, {
      'content-type': result.mimeType ?? 'application/json'
    })
    response.end(result.data ?? JSON.stringify(result.json ?? {}))
  }

  const server = createServer((request, response) => {
    void receive(request, response).catch(() => response.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('missing_peer_address')
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    traffic,
    close: async () =>
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

export function trafficJson(traffic: MediaTraffic): unknown {
  return JSON.parse(new TextDecoder().decode(traffic.data))
}

export async function multipart(traffic: MediaTraffic): Promise<FormData> {
  return new Request('http://peer.local/', {
    method: 'POST',
    headers: { 'content-type': String(traffic.headers['content-type']) },
    body: new Uint8Array(traffic.data)
  }).formData()
}

export function formJson(form: FormData, key: string): unknown {
  const value = form.get(key)
  if (typeof value !== 'string') {
    throw new TypeError('missing_json_form_field')
  }
  return JSON.parse(value)
}
