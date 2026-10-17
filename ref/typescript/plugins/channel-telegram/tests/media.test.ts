import {
  registerPeer,
  installPeerNetwork
} from '../../channel-wecom/tests/network.js'
import { connectLinePeer } from './line-network.js'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { MediaKind } from '@relanox/sdk'
import { channelConfig, httpIngress, nativeTargets } from './media-events.js'
import type { PrimaryChannel } from './media-events.js'
import {
  mediaPeer,
  multipart,
  multipartBytes,
  trafficJson,
  formJson
} from './media-peer.js'
import { discordPeer } from '../../channel-discord/tests/media-peer.js'
import type { MediaReply, MediaTraffic } from './media-peer.js'
import { mediaRuntime } from './media-runtime.js'
import { dispatchedMedia, readMedia } from './media-tools.js'
import type { Cleanup } from './media-runtime.js'

installPeerNetwork()

const cleanups: Cleanup[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})
const inputBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128)

const outputBytes = Uint8Array.of(
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
  255,
  128,
  0,
  19
)

// @larksuiteoapi/node-sdk 1.75.0 normalize/converters/{post,audio,video,file}
// Retains native resource markers in the text alongside separately stored bytes.
// These are independent protocol expectations, not normalize() output reused by
// The assertion. Keep caption, resource key, filename and duration observable.
const feishuInboundText = {
  image: 'native caption![image](img_700)',
  audio: '<audio key="file_700" duration="1s"/>',
  video: '<video key="file_700" name="incoming.bin" duration="1s"/>',
  file: '<file key="file_700" name="incoming.bin"/>'
}

function expectedInboundText(
  channel: PrimaryChannel,
  kind: MediaKind,
  caption: string
): string {
  return channel === 'feishu' ? feishuInboundText[kind] : caption
}

const channels: PrimaryChannel[] = [
  'telegram',
  'discord',
  'slack',
  'feishu',
  'line'
]

const cases = channels.flatMap((channel) =>
  (['image', 'audio', 'video', 'file'] as const)
    .filter((kind) => channel !== 'line' || kind !== 'file')
    .map((kind) => ({ channel, kind }))
)

const mimes = {
  image: 'image/png',
  audio: 'audio/mpeg',
  video: 'video/mp4',
  file: 'application/pdf'
}

function nativeReply(
  channel: PrimaryChannel,
  traffic: MediaTraffic,
  origin: string,
  mimeType: string
): MediaReply {
  if (traffic.path === '/auth.test') {
    return {
      json: { ok: true, team_id: 'T999', user_id: 'U999', bot_id: 'B999' }
    }
  }
  if (traffic.path === '/users/@me') {
    return { json: { id: '999', bot: true } }
  }
  if (traffic.path === '/gateway/bot') {
    return { json: { url: 'wss://gateway.discord.gg' } }
  }
  if (traffic.path === '/open-apis/bot/v3/info') {
    return { json: { code: 0, bot: { open_id: 'ou_999' } } }
  }
  if (channel === 'line' && traffic.path === '/v2/bot/info') {
    return { json: { userId: 'U999' } }
  }
  if (traffic.method === 'GET') {
    return { data: inputBytes, mimeType }
  }
  if (traffic.path.endsWith('/getFile')) {
    return {
      json: {
        ok: true,
        result: {
          file_path: 'photos/incoming.png',
          file_size: inputBytes.byteLength
        }
      }
    }
  }
  if (traffic.path.includes('tenant_access_token')) {
    return {
      json: { code: 0, tenant_access_token: 'tenant-access', expire: 7200 }
    }
  }
  if (traffic.path.endsWith('/images')) {
    return { json: { code: 0, data: { image_key: 'img_generated' } } }
  }
  if (traffic.path.endsWith('/files')) {
    return { json: { code: 0, data: { file_key: 'file_generated' } } }
  }
  if (traffic.path.endsWith('/files.getUploadURLExternal')) {
    return {
      json: {
        ok: true,
        upload_url: 'https://files.slack.com/upload',
        file_id: 'FGENERATED'
      }
    }
  }
  if (traffic.path.endsWith('/upload')) {
    return { json: {} }
  }
  if (traffic.path.endsWith('/files.completeUploadExternal')) {
    return { json: { ok: true, files: [{ id: 'FGENERATED' }] } }
  }
  switch (channel) {
    case 'telegram': {
      return { json: { ok: true, result: { message_id: 900 } } }
    }
    case 'discord': {
      return { json: { id: '900' } }
    }
    case 'slack': {
      return { json: { ok: true, ts: '900.1' } }
    }
    case 'feishu': {
      return { json: { code: 0, data: { message_id: 'om_900' } } }
    }
    case 'line': {
      return { json: { sentMessages: [{ id: '900' }] } }
    }
  }
  throw new Error('unsupported_test_channel')
}

function firstEffect(
  traffic: MediaTraffic[],
  channel: PrimaryChannel
): MediaTraffic | undefined {
  const paths = {
    telegram: '/send',
    discord: '/messages',
    slack: '/files.completeUploadExternal',
    feishu: '/reply',
    line: '/message/push'
  }

  return traffic.find(
    (item) => item.method === 'POST' && item.path.includes(paths[channel])
  )
}

async function assertNativeOutput(
  channel: PrimaryChannel,
  traffic: MediaTraffic[],
  kind: MediaKind,
  expected: Uint8Array
): Promise<void> {
  const effect = firstEffect(traffic, channel)
  if (!effect) {
    throw new Error('missing_native_effect')
  }
  if (channel === 'telegram' || channel === 'discord') {
    const form = await multipart(effect)

    const field =
      channel === 'discord'
        ? 'files[0]'
        : { image: 'photo', audio: 'audio', video: 'video', file: 'document' }[
            kind
          ]

    const file = form.get(field)
    if (!(file instanceof File)) {
      throw new Error('missing_native_binary')
    }
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(expected)
    if (channel === 'telegram') {
      expect(form.get('chat_id')).toBe('456')
      expect(form.get('message_thread_id')).toBe('8')
      expect(form.has('reply_parameters')).toBe(false)
    } else {
      expect(formJson(form, 'payload_json')).toMatchObject({
        allowed_mentions: { parse: [], replied_user: false },
        attachments: [{ id: 0, filename: 'generated.png' }]
      })
      expect(formJson(form, 'payload_json')).not.toHaveProperty(
        'message_reference'
      )
    }
  } else if (channel === 'slack') {
    const upload = traffic.find((item) => item.path === '/upload')
    if (!upload) {
      throw new Error('missing_slack_upload')
    }
    // WebClient 8.2.0 postFileUploadsToExternalURL calls makeRequest({body}),
    // Whose serializeBody wraps that binary value in the multipart `body` field.
    const file = (await multipart(upload)).get('body')
    expect(file).toBeInstanceOf(File)
    if (!(file instanceof File)) {
      throw new Error('missing_slack_upload_bytes')
    }
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(expected)
    expect(trafficJson(effect)).toMatchObject({
      files: [{ id: 'FGENERATED' }],
      channel_id: 'C456',
      thread_ts: '9.1'
    })
    const download = traffic.find((item) => item.method === 'GET')
    expect(download?.headers.authorization).toBe('Bearer native-token')
  } else if (channel === 'feishu') {
    const upload = traffic.find((item) =>
      item.path.endsWith(kind === 'image' ? '/images' : '/files')
    )

    if (!upload) {
      throw new Error('missing_feishu_upload')
    }
    const form = await multipart(upload)
    // Node-sdk 1.75.0 passes Buffer to its Axios multipart serializer without
    // A filename. RFC 7578 section 4.2 permits this; formData() reads such a
    // Field as text, so inspect its original bytes instead of corrupting UTF-8.
    expect(multipartBytes(upload, kind === 'image' ? 'image' : 'file')).toEqual(
      expected
    )
    expect(form.get(kind === 'image' ? 'image_type' : 'file_type')).toBe(
      { image: 'message', audio: 'opus', video: 'mp4', file: 'stream' }[kind]
    )
    expect(trafficJson(effect)).toMatchObject({
      msg_type: {
        image: 'image',
        audio: 'audio',
        video: 'media',
        file: 'file'
      }[kind],
      reply_in_thread: true
    })
    expect(effect.path).toBe('/open-apis/im/v1/messages/om_9/reply')
  } else {
    const payload = z
      .object({
        to: z.string(),
        messages: z.array(
          z.looseObject({ type: z.string(), originalContentUrl: z.url() })
        )
      })
      .parse(trafficJson(effect))

    expect(payload.to).toBe('42')
    const media = payload.messages[0]
    if (!media) {
      throw new Error('missing_line_media')
    }
    expect(media.type).toBe(kind)
    const downloaded = await fetch(media.originalContentUrl)
    expect(downloaded.status).toBe(200)
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(expected)
    expect(media.originalContentUrl).not.toContain('media-agent-token')
  }
}

function peerOrigin(channel: PrimaryChannel, origin: string): string {
  return ['telegram', 'line'].includes(channel) ? origin : registerPeer(origin)
}

// Preserve the cross-channel CLI/Core contract: authenticated media reads,
// Exact bytes through SQLite, and native delivery to the frozen conversation.
// Wrong multipart handling or missing SDK-normalized content must fail; isolated
// Channel peers do not cover this complete path. No production seam is added.
it.each(cases)(
  '$channel relays pure native $kind bytes through authenticated media reads and SQLite to the frozen reply',
  async ({ channel, kind }) => {
    const mimeType =
      channel === 'feishu' && kind === 'audio' ? 'audio/ogg' : mimes[kind]

    let origin = ''
    let uploads = 0

    const remote = await mediaPeer((traffic) => {
      if (
        channel === 'slack' &&
        kind === 'audio' &&
        traffic.path === '/upload'
      ) {
        uploads += 1
        if (uploads === 1) {
          return { status: 503 }
        }
      }
      return nativeReply(channel, traffic, origin, mimeType)
    })

    origin = peerOrigin(channel, remote.origin)
    cleanups.push(remote.close)
    if (channel === 'line') {
      cleanups.push(connectLinePeer(origin))
    }
    const gateway = channel === 'discord' ? await discordPeer() : undefined
    if (gateway) {
      cleanups.push(gateway.close)
    }
    const destination = nativeTargets[channel]

    const fixture = await mediaRuntime(
      cleanups,
      channel,
      channelConfig(channel, origin, gateway?.url),
      destination.chat,
      'thread' in destination ? destination.thread : undefined
    )

    let runtime = await fixture.start()

    const caption =
      kind === 'image' && channel !== 'line' ? 'native caption' : ''

    if (gateway) {
      await expect.poll(gateway.connected, { timeout: 5000 }).toBe(true)
      gateway.message({
        id: '789',
        channel_id: '456',
        content: caption,
        type: 0,
        author: { id: '42' },
        attachments: [
          {
            id: '700',
            filename: 'incoming.png',
            content_type: mimeType,
            size: inputBytes.byteLength,
            url: `${origin}/asset`
          }
        ]
      })
    } else {
      expect(
        (
          await httpIngress(
            runtime,
            channel as Exclude<PrimaryChannel, 'discord'>,
            kind,
            origin,
            inputBytes.byteLength,
            mimeType,
            caption
          )
        ).status
        // Feishu requires HTTP 200 to acknowledge native callback events.
        // https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq
      ).toBe(channel === 'line' || channel === 'feishu' ? 200 : 204)
    }
    await expect
      .poll(() => fixture.routine.traffic.length, { timeout: 5000 })
      .toBe(1)
    if (channel === 'telegram' && kind === 'image') {
      await runtime.stop()
      runtime = await fixture.start()
    }
    const client = await fixture.client(runtime)
    const request = await dispatchedMedia(fixture.routine)
    expect(request.text).toBe(expectedInboundText(channel, kind, caption))
    expect(request.attachments).toMatchObject([
      { kind, mimeType, size: inputBytes.byteLength }
    ])
    const inbound = request.attachments[0]
    if (!inbound) {
      throw new Error('missing_input_asset')
    }
    expect(
      await readMedia(client, request.source.channel.id, inbound.id)
    ).toEqual(inputBytes)

    const media = {
      kind,
      mimeType,
      fileName: 'generated.png',
      durationMs: 1000,
      data: outputBytes
    }

    const attachment =
      kind === 'video' && channel === 'line'
        ? {
            media,
            preview: {
              kind: 'image' as const,
              mimeType: 'image/png',
              fileName: 'preview.png',
              data: outputBytes
            }
          }
        : media

    expect(
      await fixture.principal().sendMessage({
        channel: request.source.channel.id,
        idempotencyKey: 'generated-message',
        text: '',
        attachments: [attachment]
      })
    ).toMatchObject({ status: 'queued' })
    await expect
      .poll(async () => (await runtime.core.status()).deliveries[0]?.status, {
        timeout: 5000
      })
      .toBe('sent')
    if (channel === 'slack' && kind === 'audio') {
      expect(uploads).toBe(2)
      expect(
        remote.traffic.filter((item) =>
          item.path.endsWith('/files.completeUploadExternal')
        )
      ).toHaveLength(1)
    }
    await assertNativeOutput(channel, remote.traffic, kind, outputBytes)
  }
)

it('forwards a received WAV document as a Telegram document with its bytes intact', async () => {
  // Telegram sendAudio accepts MP3/M4A; a WAV needs sendDocument.
  // https://core.telegram.org/bots/api#sendaudio
  const wav = Uint8Array.from(
    Buffer.from(
      '524946462500000057415645666d74201000000001000100401f0000401f000001000800646174610100000080',
      'hex'
    )
  )

  // GetFile returns a file_path; successful send methods return a Message.
  // https://core.telegram.org/bots/api#getfile
  // https://core.telegram.org/bots/api#sendaudio
  const remote = await mediaPeer((traffic) => {
    if (traffic.method === 'GET') {
      return { data: wav, mimeType: 'audio/wav' }
    }
    if (traffic.path.endsWith('/getFile')) {
      return {
        json: {
          ok: true,
          result: { file_path: 'documents/incoming.wav', file_size: wav.length }
        }
      }
    }
    return { json: { ok: true, result: { message_id: 900 } } }
  })

  cleanups.push(remote.close)

  const fixture = await mediaRuntime(
    cleanups,
    'telegram',
    channelConfig('telegram', remote.origin),
    '456',
    '8'
  )

  const runtime = await fixture.start()
  expect(
    (
      await httpIngress(
        runtime,
        'telegram',
        'file',
        remote.origin,
        wav.length,
        'audio/wav'
      )
    ).status
  ).toBe(204)
  await expect
    .poll(() => fixture.routine.traffic.length, { timeout: 5000 })
    .toBe(1)
  const request = await dispatchedMedia(fixture.routine)
  expect(request.attachments).toMatchObject([
    { kind: 'audio', mimeType: 'audio/wav' }
  ])
  const inbound = request.attachments[0]
  if (!inbound) {
    throw new Error('missing_input_asset')
  }
  expect(
    await readMedia(
      await fixture.client(runtime),
      request.source.channel.id,
      inbound.id
    )
  ).toEqual(wav)
  expect(
    await fixture.principal().sendMessage({
      channel: request.source.channel.id,
      idempotencyKey: 'forward-wav',
      text: '',
      attachments: [
        {
          kind: 'audio',
          mimeType: 'audio/wav',
          fileName: 'forward.wav',
          data: wav
        }
      ]
    })
  ).toMatchObject({ status: 'queued' })
  await expect
    .poll(async () => (await runtime.core.status()).deliveries[0]?.status, {
      timeout: 5000
    })
    .toBe('sent')

  const outbound = remote.traffic.find((item) =>
    item.path.endsWith('/sendDocument')
  )

  expect(outbound?.path).toBe('/bot123:abc_DEF/sendDocument')
  if (!outbound) {
    throw new Error('missing_document_upload')
  }
  const form = await multipart(outbound)
  const file = form.get('document')
  expect(file).toBeInstanceOf(File)
  expect(
    file instanceof File ? new Uint8Array(await file.arrayBuffer()) : undefined
  ).toEqual(wav)
  expect(form.has('audio')).toBe(false)

  for (const [mimeType, fileName, method, field] of [
    ['audio/mpeg', 'forward.mp3', 'sendAudio', 'audio'],
    ['audio/mp4', 'forward.m4a', 'sendAudio', 'audio'],
    ['audio/ogg', 'forward.ogg', 'sendVoice', 'voice'],
    ['audio/opus', 'forward.opus', 'sendVoice', 'voice']
  ] as const) {
    const priorTraffic = remote.traffic.length
    expect(
      await fixture.principal().sendMessage({
        channel: request.source.channel.id,
        idempotencyKey: `forward-${fileName}`,
        text: '',
        attachments: [{ kind: 'audio', mimeType, fileName, data: wav }]
      })
    ).toMatchObject({ status: 'queued' })
    await expect
      .poll(() => remote.traffic.length, { timeout: 5000 })
      .toBe(priorTraffic + 1)
    const upload = remote.traffic.at(-1)
    expect(upload?.path).toBe(`/bot123:abc_DEF/${method}`)
    if (!upload) {
      throw new Error('missing_audio_upload')
    }
    const uploaded = (await multipart(upload)).get(field)
    expect(uploaded).toBeInstanceOf(File)
    expect(uploaded instanceof File ? uploaded.name : '').toBe(fileName)
  }
})
