import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { downloadMedia } from '../../packages/channel-media/src/index.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function peer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{
  origin: string
  options: {
    trustedOrigins: string[]
    allowInsecureLocalhost: boolean
    maxBytes: number
    signal: AbortSignal
  }
}> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('missing_peer_address')
  }
  cleanups.push(async () => {
    server.closeAllConnections()
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
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    options: {
      trustedOrigins: [origin],
      allowInsecureLocalhost: true,
      maxBytes: 16,
      signal: AbortSignal.timeout(2000)
    }
  }
}

it('downloads exact binary bytes from an explicitly configured native API origin', async () => {
  const bytes = Buffer.from([0, 255, 12, 128])
  let authorization: string | undefined

  const { origin, options } = await peer((request, response) => {
    authorization = request.headers.authorization
    response.writeHead(200, { 'content-type': 'image/png; charset=binary' })
    response.end(bytes)
  })

  const media = await downloadMedia(`${origin}/file`, {
    ...options,
    headers: { Authorization: 'Bearer native-test' }
  })

  expect(Buffer.from(media.data)).toEqual(bytes)
  expect(media.mimeType).toBe('image/png')
  expect(authorization).toBe('Bearer native-test')
})

// LINE content downloads return 202 while audio/video is being prepared:
// https://developers.line.biz/en/reference/messaging-api/#get-content
it.each([200, 202])(
  'preserves native successful HTTP status %s',
  async (status) => {
    const { origin, options } = await peer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/octet-stream' })
      response.end()
    })

    const downloaded = await downloadMedia(`${origin}/content`, options)
    expect(downloaded).toHaveProperty('status', status)
  }
)

// RFC 6266 sections 4.3 and 5: prefer UTF-8 filename*, preserve quoted names,
// Discard path segments, and ignore unusable filename metadata.
// https://www.rfc-editor.org/rfc/rfc6266#section-4.3
// WeCom returns native attachment names in this header, not its message object:
// https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/api.ts#L26-L52
it.each([
  ['attachment; filename=report.pdf', 'report.pdf'],
  ['attachment; filename="report; Q4.pdf"', 'report; Q4.pdf'],
  [
    "attachment; filename=report.pdf; filename*=UTF-8'zh'%E6%8A%A5%E5%91%8A.pdf",
    '报告.pdf'
  ],
  ['attachment; filename="100%25.pdf"', '100%25.pdf'],
  ['attachment; filename="../../budget.pdf"', 'budget.pdf'],
  ["attachment; filename=report.pdf; filename*=UTF-8''%ZZ", 'report.pdf'],
  ["attachment; filename*=UTF-8''%0A.pdf", undefined],
  ['attachment; filename=".."', undefined]
])(
  'preserves safe response filenames from %s',
  async (disposition, expected) => {
    const { origin, options } = await peer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': disposition
      })
      response.end('file')
    })

    const downloaded = await downloadMedia(`${origin}/file`, options)
    expect(downloaded.fileName).toBe(expected)
    expect(Buffer.from(downloaded.data).toString()).toBe('file')
  }
)

it('rejects message-controlled loopback URLs before contacting them', async () => {
  let requests = 0

  const { origin, options } = await peer((_request, response) => {
    requests += 1
    response.end('private')
  })

  await expect(
    downloadMedia(`${origin}/private`, { maxBytes: 16, signal: options.signal })
  ).rejects.toMatchObject({ code: 'forbidden_destination' })
  expect(requests).toBe(0)
})

it('does not forward authenticated download redirects', async () => {
  let leakedRequests = 0

  const destination = await peer((_request, response) => {
    leakedRequests += 1
    response.end('unexpected')
  })

  const { origin, options } = await peer((_request, response) => {
    response.writeHead(302, { location: `${destination.origin}/secret` })
    response.end()
  })

  await expect(
    downloadMedia(origin, {
      ...options,
      headers: { Authorization: 'Bearer native-test' }
    })
  ).rejects.toMatchObject({ code: 'media_download_failed', status: 302 })
  expect(leakedRequests).toBe(0)
})

it.each([true, false])(
  'bounds actual response bytes with content-length=%s',
  async (declared) => {
    const { origin, options } = await peer((_request, response) => {
      response.writeHead(200, declared ? { 'content-length': '32' } : {})
      response.end(Buffer.alloc(32, 1))
    })

    await expect(downloadMedia(origin, options)).rejects.toMatchObject({
      code: 'media_too_large'
    })
  }
)

it('cancels a stalled authenticated response at the caller deadline', async () => {
  const { origin, options } = await peer((_request, response) => {
    response.writeHead(200)
    response.write('one')
  })

  await expect(
    downloadMedia(origin, { ...options, signal: AbortSignal.timeout(50) })
  ).rejects.toMatchObject({ code: 'media_timeout' })
})

it('never sends supplied credentials to a public but untrusted origin', async () => {
  await expect(
    downloadMedia('https://example.com/attachment', {
      signal: AbortSignal.timeout(1000),
      maxBytes: 16,
      headers: { Authorization: 'Bearer native-test' }
    })
  ).rejects.toMatchObject({ code: 'forbidden_destination' })
})
