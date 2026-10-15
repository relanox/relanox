import { listenPeer } from '../../../tests/listen.js'
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

  await listenPeer(server)
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
  const body = new TextDecoder().decode(traffic.data)
  // @slack/web-api 8.2.0 WebClient.serializeBody URL-encodes scalar API
  // Arguments and JSON-encodes structured fields such as the completion files.
  if (
    traffic.headers['content-type']?.includes(
      'application/x-www-form-urlencoded'
    )
  ) {
    return Object.fromEntries(
      Array.from(new URLSearchParams(body), ([key, value]) => [
        key,
        key === 'files' ? (JSON.parse(value) as unknown) : value
      ])
    )
  }
  return JSON.parse(body)
}

export async function multipart(traffic: MediaTraffic): Promise<FormData> {
  return new Request('http://peer.local/', {
    method: 'POST',
    headers: { 'content-type': String(traffic.headers['content-type']) },
    body: new Uint8Array(traffic.data)
  }).formData()
}

/** Read an RFC 7578 part without UTF-8-decoding its binary payload. */
export function multipartBytes(
  traffic: MediaTraffic,
  field: string
): Uint8Array {
  const contentType = String(traffic.headers['content-type'])

  const boundary = /boundary=(?:"(?<quoted>[^"]+)"|(?<plain>[^;]+))/iu.exec(
    contentType
  )?.groups

  const value = boundary?.quoted ?? boundary?.plain?.trim()
  if (!value || !contentType.startsWith('multipart/form-data')) {
    throw new Error('missing_multipart_boundary')
  }
  const data = Buffer.from(traffic.data)
  const marker = Buffer.from(`--${value}`)
  const separator = Buffer.from(`\r\n--${value}`)
  let cursor = data.indexOf(marker)
  while (cursor >= 0) {
    const headersStart = cursor + marker.byteLength + 2
    const headersEnd = data.indexOf('\r\n\r\n', headersStart)
    if (headersEnd === -1) {
      break
    }
    const start = headersEnd + 4
    const end = data.indexOf(separator, start)
    if (end === -1) {
      throw new Error('invalid_multipart_ending')
    }

    const disposition = data
      .subarray(headersStart, headersEnd)
      .toString('latin1')
      .split('\r\n')
      .find((header) => /^content-disposition:/iu.test(header))

    if (
      /(?:^|;)\s*name="(?<name>[^"]+)"/iu.exec(disposition ?? '')?.groups
        ?.name === field
    ) {
      return new Uint8Array(data.subarray(start, end))
    }
    cursor = end + 2
  }
  throw new Error('missing_multipart_field')
}

export function formJson(form: FormData, key: string): unknown {
  const value = form.get(key)
  if (typeof value !== 'string') {
    throw new TypeError('missing_json_form_field')
  }
  return JSON.parse(value)
}
