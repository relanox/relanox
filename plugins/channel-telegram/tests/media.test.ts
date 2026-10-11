import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { MediaKind } from '@relanox/sdk'
import { channelConfig, httpIngress, nativeTargets } from './media-events.js'
import type { PrimaryChannel } from './media-events.js'
import { mediaPeer, multipart, trafficJson, formJson } from './media-peer.js'
import { discordPeer } from '../../channel-discord/tests/media-peer.js'
import type { MediaReply, MediaTraffic } from './media-peer.js'
import { mediaRuntime } from './media-runtime.js'
import { dispatchedMedia, readMedia } from './media-tools.js'
import type { Cleanup } from './media-runtime.js'

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
      json: { ok: true, upload_url: `${origin}/upload`, file_id: 'FGENERATED' }
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
      expect(formJson(form, 'reply_parameters')).toMatchObject({
        message_id: 9
      })
    } else {
      expect(formJson(form, 'payload_json')).toMatchObject({
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: '789' },
        attachments: [{ id: 0, filename: 'generated.png' }]
      })
    }
  } else if (channel === 'slack') {
    const upload = traffic.find((item) => item.path === '/upload')
    if (!upload) {
      throw new Error('missing_slack_upload')
    }
    expect(new Uint8Array(upload.data)).toEqual(expected)
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
    const file = form.get(kind === 'image' ? 'image' : 'file')
    if (!(file instanceof File)) {
      throw new Error('missing_feishu_binary')
    }
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(expected)
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

    origin = remote.origin
    cleanups.push(remote.close)
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
      ).toBe(channel === 'line' ? 200 : 204)
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
    expect(request.text).toBe(caption)
    expect(request.attachments).toMatchObject([
      { kind, mimeType, size: inputBytes.byteLength }
    ])
    const inbound = request.attachments[0]
    if (!inbound) {
      throw new Error('missing_input_asset')
    }
    expect(await readMedia(client, request.replyTo, inbound.id)).toEqual(
      inputBytes
    )

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
        replyTo: request.replyTo,
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
