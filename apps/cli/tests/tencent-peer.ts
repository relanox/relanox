import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { closeServer, listen } from '../src/listeners.js'
import { vi } from 'vitest'

type RecordedRequest = {
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** HTTP-only Tencent protocol peer. It neither routes nor persists Relanox messages. */
export async function tencentPeer(): Promise<{
  readonly requests: RecordedRequest[]
  reply(body: unknown, status?: number): void
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

  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      requests.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8')
      })
      response.writeHead(statusCode, { 'content-type': 'application/json' })
      response.end(JSON.stringify(responseBody))
    })
  })

  const url = await listen(server, 0, '127.0.0.1')
  const original = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      if (
        (input instanceof Request ? input.url : String(input)) !==
        'https://asr.tencentcloudapi.com/'
      ) {
        throw new Error('Unexpected speech request destination')
      }
      return original(url, init)
    }
  )
  return {
    requests,
    reply(body, status = 200): void {
      responseBody = body
      statusCode = status
    },
    async close(): Promise<void> {
      vi.unstubAllGlobals()
      await closeServer(server)
    }
  }
}
