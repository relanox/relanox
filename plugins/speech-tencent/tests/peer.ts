import { createServer, request as httpRequest } from 'node:http'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  RequestOptions
} from 'node:http'
import https from 'node:https'
import { once } from 'node:events'
import { vi } from 'vitest'

type RecordedRequest = {
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** HTTP-only Tencent protocol peer. It neither routes nor persists Relanox messages. */
export async function tencentPeer(): Promise<{
  readonly requests: RecordedRequest[]
  readonly closedResponses: number
  reply(body: unknown, status?: number): void
  hold(): void
  close(): Promise<void>
}> {
  const requests: RecordedRequest[] = []

  // Official SentenceRecognition output; nullable word timing is not required for plain transcription.
  // https://cloud.tencent.com/document/api/1093/35646
  let responseBody: unknown = {
    Response: {
      Result: '腾讯云语音识别欢迎您。',
      AudioDuration: 2430,
      WordSize: null,
      WordList: null,
      RequestId: '41ed9283-0c09-46fb-917b-0b83fa95f0be'
    }
  }

  let statusCode = 200
  let held = false
  let closedResponses = 0

  const server = createServer((request, response) => {
    response.on('close', () => {
      closedResponses += 1
    })
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      requests.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8')
      })
      if (held) {
        return
      }
      response.writeHead(statusCode, { 'content-type': 'application/json' })
      response.end(JSON.stringify(responseBody))
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('missing_peer_address')
  }
  const port = address.port

  function redirect(
    options: string | URL | RequestOptions,
    callback?: (response: IncomingMessage) => void
  ): ReturnType<typeof httpRequest>
  function redirect(
    input: string | URL,
    options: RequestOptions,
    callback?: (response: IncomingMessage) => void
  ): ReturnType<typeof httpRequest>
  function redirect(
    options: string | URL | RequestOptions,
    callback?: RequestOptions | ((response: IncomingMessage) => void)
  ): ReturnType<typeof httpRequest> {
    if (
      typeof options !== 'object' ||
      options instanceof URL ||
      options.hostname !== 'asr.tencentcloudapi.com' ||
      typeof callback === 'object'
    ) {
      throw new Error('Unexpected speech request destination')
    }
    // Route only the socket to the peer. The real SDK builds/signs requests and parses responses.
    return httpRequest(
      {
        ...options,
        protocol: 'http:',
        hostname: '127.0.0.1',
        port,
        agent: undefined
      },
      callback
    )
  }

  const network = vi.spyOn(https, 'request').mockImplementation(redirect)
  return {
    requests,
    get closedResponses() {
      return closedResponses
    },
    hold(): void {
      held = true
    },
    reply(body, status = 200): void {
      responseBody = body
      statusCode = status
    },
    async close(): Promise<void> {
      network.mockRestore()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        server.closeAllConnections()
      })
    }
  }
}
