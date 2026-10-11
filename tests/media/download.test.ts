import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { downloadMedia } from '../../packages/media/src/index.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function peer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
) {
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
