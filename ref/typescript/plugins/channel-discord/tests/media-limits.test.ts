import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createDiscordChannel } from '../src/index.js'
import { httpPeer, json } from '../../channel-matrix/tests/harness.js'
import { richHost, richInput } from '../../channel-matrix/tests/rich-fixture.js'
import {
  installPeerNetwork,
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'

installPeerNetwork()

// Discord raised the default per-file cap to 20 MiB for bots on 2026-09-03.
// https://docs.discord.com/developers/change-log#default-file-upload-limit-increase
// Native files[n]/payload_json follow
// https://docs.discord.com/developers/reference#uploading-files
it.each([
  { size: 11 * 1024 * 1024, maximum: 25 * 1024 * 1024, sent: true },
  { size: 20 * 1024 * 1024, maximum: 25 * 1024 * 1024, sent: true },
  { size: 20 * 1024 * 1024 + 1, maximum: 25 * 1024 * 1024, sent: false },
  { size: 5, maximum: 4, sent: false }
])(
  'honors the native file cap and lower relay cap for $size bytes',
  async ({ size, maximum, sent }) => {
    const uploaded: {
      bytes: number
      first: number | undefined
      last: number | undefined
      payload: unknown
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

      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': request.headers['content-type'] ?? '' }
      }).formData()

      const file = form.get('files[0]')
      const payload = form.get('payload_json')
      if (!(file instanceof File) || typeof payload !== 'string') {
        throw new TypeError('missing_native_file_upload')
      }
      const received = new Uint8Array(await file.arrayBuffer())
      uploaded.push({
        bytes: received.byteLength,
        first: received[0],
        last: received.at(-1),
        payload: JSON.parse(payload)
      })
      json(response, { id: '900' })
    })

    routePlatform('https://discord.com', registerPeer(remote.base))
    const plugin = createDiscordChannel({ TOKEN: 'secret' })
    const { host } = await richHost(false)
    await plugin.setup(
      { ...host, maxMediaBytes: maximum },
      { id: 'account', channel: 'discord', config: null, allowedSenders: [] },
      plugin.validateConfig({ botToken: { env: 'TOKEN' } })
    )

    const initial = richInput({
      channel: 'discord',
      accountId: 'account',
      chatId: '456',
      data: { botId: '999', apiBaseUrl: 'https://discord.com/api/v10' }
    })

    const data = new Uint8Array(size)
    data[0] = 9
    data[size - 1] = 8

    const media = {
      data,
      reference: {
        id: '87dc7f2b-c7df-4be7-908e-8a85d1e4e707',
        kind: 'file' as const,
        mimeType: 'application/octet-stream',
        fileName: 'large.bin',
        size,
        sha256: createHash('sha256').update(data).digest('hex')
      }
    }

    const result = await plugin.send({
      ...initial,
      chunk: {
        text: '',
        media: media.reference,
        idempotencyKey: 'native-cap:0',
        state: null
      },
      richMedia: [],
      media
    })

    if (!sent) {
      expect(result).toEqual({
        status: 'rejected',
        errorCode: 'media_limit_exceeded'
      })
      expect(uploaded).toEqual([])
      return
    }
    expect(result).toEqual({
      status: 'sent',
      receipt: { platformMessageId: '900' }
    })
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]).toMatchObject({ bytes: size, first: 9, last: 8 })
    expect(uploaded[0]?.payload).toMatchObject({
      attachments: [{ id: 0, filename: 'large.bin' }]
    })
  }
)
