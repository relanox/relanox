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

it('sends ordered Components V2 with attachment bytes and preserves nonce and mention restrictions', async () => {
  const sent: {
    path: string
    authorization: string | undefined
    payload: unknown
    bytes: number[]
    filename: string
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

    const native = new Response(Buffer.concat(chunks), {
      headers: { 'content-type': request.headers['content-type'] ?? '' }
    })

    const form = await native.formData()
    const file = form.get('files[0]')
    const payload = form.get('payload_json')
    if (!(file instanceof File)) {
      throw new Error('missing_uploaded_file')
    }
    if (typeof payload !== 'string') {
      throw new TypeError('missing_message_payload')
    }
    sent.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      payload: JSON.parse(payload),
      bytes: [...new Uint8Array(await file.arrayBuffer())],
      filename: file.name
    })
    json(response, { id: '123' })
  })

  routePlatform('https://discord.com', registerPeer(remote.base))
  const plugin = createDiscordChannel({ TOKEN: 'secret' })
  const { host } = await richHost(false)
  await plugin.setup(
    host,
    { id: 'account', channel: 'discord', config: null, allowedSenders: [] },
    plugin.validateConfig({ botToken: { env: 'TOKEN' } })
  )

  const input = richInput({
    channel: 'discord',
    accountId: 'account',
    chatId: '456',
    replyToId: '789',
    data: { botId: '999', apiBaseUrl: 'https://discord.com/api/v10' }
  })

  expect(await plugin.send(input)).toEqual({
    status: 'sent',
    receipt: { platformMessageId: '123' }
  })
  expect(sent[0]).toMatchObject({
    path: '/channels/456/messages',
    authorization: 'Bot secret',
    filename: 'image-0.png',
    bytes: [9, 8, 7],
    payload: {
      flags: 32_768,
      components: [
        { type: 10, content: '**Before**' },
        {
          type: 12,
          items: [
            {
              media: { url: 'attachment://image-0.png' },
              description: 'Chart ] <unsafe>'
            }
          ]
        },
        { type: 10, content: '*After*' }
      ],
      attachments: [{ id: 0, filename: 'image-0.png' }],
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: '789', fail_if_not_exists: false },
      enforce_nonce: true
    }
  })
  expect(sent[0]?.payload).not.toHaveProperty('content')
  expect(sent[0]?.payload).toHaveProperty(
    'nonce',
    expect.stringMatching(/^[a-f\d]{24}$/u)
  )
  expect(await plugin.send({ ...input, richMedia: [] })).toEqual({
    status: 'rejected',
    errorCode: 'missing_media'
  })
  expect(sent).toHaveLength(1)
})

// Discord's native upload uses files[n] and payload_json, with attachment IDs
// Matching multipart indices: https://docs.discord.com/developers/reference#uploading-files
it.each([
  { kind: 'image', mimeType: 'image/png', fileName: 'picture.png' },
  { kind: 'audio', mimeType: 'audio/ogg', fileName: 'recording.ogg' },
  { kind: 'video', mimeType: 'video/mp4', fileName: 'clip.mp4' },
  { kind: 'file', mimeType: 'application/pdf', fileName: 'report.pdf' }
] as const)(
  'uploads ordinary $kind attachment bytes with native multipart metadata',
  async ({ kind, mimeType, fileName }) => {
    const uploaded: {
      payload: unknown
      bytes: number[]
      fileName: string
      mimeType: string
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
        throw new TypeError('missing_native_upload')
      }
      uploaded.push({
        payload: JSON.parse(payload),
        bytes: [...new Uint8Array(await file.arrayBuffer())],
        fileName: file.name,
        mimeType: file.type
      })
      json(response, { id: '124' })
    })

    routePlatform('https://discord.com', registerPeer(remote.base))
    const plugin = createDiscordChannel({ TOKEN: 'secret' })
    const { host } = await richHost(false)
    await plugin.setup(
      host,
      { id: 'account', channel: 'discord', config: null, allowedSenders: [] },
      plugin.validateConfig({ botToken: { env: 'TOKEN' } })
    )

    const initial = richInput({
      channel: 'discord',
      accountId: 'account',
      chatId: '456',
      data: { botId: '999', apiBaseUrl: 'https://discord.com/api/v10' }
    })

    const stored = initial.richMedia?.[0]
    if (!stored) {
      throw new Error('missing_fixture_media')
    }

    const media = {
      ...stored,
      reference: { ...stored.reference, kind, mimeType, fileName }
    }

    expect(
      await plugin.send({
        ...initial,
        chunk: {
          text: 'caption @everyone',
          media: media.reference,
          idempotencyKey: 'attachment:0',
          state: null
        },
        richMedia: [],
        media
      })
    ).toEqual({ status: 'sent', receipt: { platformMessageId: '124' } })
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]).toMatchObject({
      payload: {
        content: 'caption @everyone',
        allowed_mentions: { parse: [], replied_user: false },
        enforce_nonce: true,
        attachments: [{ id: 0, filename: fileName }]
      },
      bytes: [9, 8, 7],
      fileName,
      mimeType
    })
    expect(uploaded[0]?.payload).toHaveProperty(
      'nonce',
      expect.stringMatching(/^[a-f\d]{24}$/u)
    )
    expect(uploaded[0]?.payload).not.toHaveProperty('flags')
    expect(uploaded[0]?.payload).not.toHaveProperty('components')
  }
)
