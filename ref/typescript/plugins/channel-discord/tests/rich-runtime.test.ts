import { afterEach, expect, it, vi } from 'vitest'
import { crc32, deflate } from 'node:zlib'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { httpPeer, json } from '../../channel-matrix/tests/harness.js'
import { mediaRuntime } from '../../channel-telegram/tests/media-runtime.js'
import { discordPeer } from './media-peer.js'
import {
  installPeerNetwork,
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'

installPeerNetwork()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

function pngChunk(type: string, data: Buffer): Buffer {
  const tag = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])))
  return Buffer.concat([length, tag, data, checksum])
}

// Complete RGBA PNG: filter byte followed by 1600 pixels on each of 1600 rows.
// PNG structure, zlib stream and CRC follow https://www.w3.org/TR/png-3/.
async function largePng(): Promise<Buffer> {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1600, 0)
  header.writeUInt32BE(1600, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc(1600 * (1600 * 4 + 1), 128)
  for (let row = 0; row < 1600; row += 1) {
    rows[row * (1600 * 4 + 1)] = 0
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', await promisify(deflate)(rows, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

it('durably splits ordered inline images below the native whole-request byte limit', async () => {
  // Native Create Message caps the entire multipart request at 25 MiB:
  // https://docs.discord.com/developers/resources/message#create-message
  // Each complete PNG is below the channel's 10 MiB inline cap, but three
  // Together exceed that native request limit. Peers only record native traffic.
  const source = await largePng()
  const expectedDigest = createHash('sha256').update(source).digest('hex')

  const uploads: {
    wireBytes: number
    labels: string[]
    files: Uint8Array[]
  }[] = []

  const remote = await httpPeer(async (request, response) => {
    if (request.url === '/users/@me') {
      json(response, { id: '999', bot: true })
      return
    }
    if (request.url === '/gateway/bot') {
      json(response, { url: 'wss://gateway.discord.gg' })
      return
    }
    const chunks: Buffer[] = []
    for await (const bytes of request) {
      chunks.push(Buffer.from(bytes as Uint8Array))
    }
    const wire = Buffer.concat(chunks)
    if (wire.byteLength > 25 * 1024 * 1024) {
      json(response, { message: 'Request entity too large' }, 413)
      return
    }

    const form = await new Response(wire, {
      headers: { 'content-type': request.headers['content-type'] ?? '' }
    }).formData()

    const payloadJson = form.get('payload_json')
    if (typeof payloadJson !== 'string') {
      throw new TypeError('missing_native_payload')
    }

    const payload = JSON.parse(payloadJson) as {
      components: { content?: string; items?: { description: string }[] }[]
    }

    const files: Uint8Array[] = []
    for (const [name, value] of form) {
      if (name.startsWith('files[') && value instanceof File) {
        files.push(new Uint8Array(await value.arrayBuffer()))
      }
    }
    uploads.push({
      wireBytes: wire.byteLength,
      labels: payload.components.flatMap((part) =>
        part.content
          ? [part.content]
          : (part.items ?? []).map((item) => item.description)
      ),
      files
    })
    json(response, { id: String(900 + uploads.length) })
  })

  routePlatform('https://discord.com', registerPeer(remote.base))
  const gateway = await discordPeer()
  cleanups.push(gateway.close)
  routePlatform('wss://gateway.discord.gg', gateway.url)
  vi.stubEnv('DISCORD_RICH_TOKEN', 'discord-token')

  const fixture = await mediaRuntime(
    cleanups,
    'discord',
    { botToken: { env: 'DISCORD_RICH_TOKEN' } },
    '456'
  )

  const runtime = await fixture.start()
  const principal = fixture.principal()
  const channel = (await principal.status()).channels[0]?.channel.id
  if (!channel) {
    throw new Error('missing_configured_channel')
  }

  const result = await principal.sendMessage({
    channel,
    idempotencyKey: 'native-total-rich-bytes',
    text: 'Before\n![First](relanox://attachment/1)\nBetween\n![Second](relanox://attachment/2)\n![Third](relanox://attachment/3)\nAfter',
    attachments: [1, 2, 3].map((index) => ({
      kind: 'image' as const,
      mimeType: 'image/png',
      fileName: `picture-${index}.png`,
      data: source
    }))
  })

  expect(result.status).toBe('queued')
  await expect
    .poll(async () => (await runtime.core.status()).deliveries[0]?.status, {
      timeout: 5000
    })
    .toBe('sent')
  expect(
    uploads.flatMap((upload) => upload.labels).map((label) => label.trim())
  ).toEqual(['Before', 'First', 'Between', 'Second', 'Third', 'After'])
  expect(uploads.flatMap((upload) => upload.files)).toHaveLength(3)
  for (const upload of uploads) {
    expect(upload.wireBytes).toBeLessThanOrEqual(25 * 1024 * 1024)
    for (const bytes of upload.files) {
      expect(bytes.byteLength).toBe(source.byteLength)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        expectedDigest
      )
    }
  }
  await runtime.stop()
  const reopened = await fixture.start()
  expect((await reopened.core.status()).deliveries[0]?.status).toBe('sent')
  expect(uploads.flatMap((upload) => upload.files)).toHaveLength(3)
})
