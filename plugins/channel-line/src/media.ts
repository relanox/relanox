import { downloadMedia, mediaKind } from '@relanox/channel-media'
import type { ChannelHost, Json, MediaUpload, SendInput } from '@relanox/sdk'
import type { z } from 'zod'
import type { LineConfig } from './config.js'
import { secret } from './io.js'
import type { eventSchema } from './schemas.js'

const fallbackMime: Readonly<Record<string, string>> = {
  image: 'image/jpeg',
  audio: 'audio/mp4',
  video: 'video/mp4',
  file: 'application/octet-stream'
}

type Message = NonNullable<z.infer<typeof eventSchema>['message']>

export async function receiveMedia(
  message: Message,
  host: ChannelHost,
  config: LineConfig
): Promise<MediaUpload[]> {
  if (message.type === 'text') {
    return []
  }
  const maximum = host.maxMediaBytes ?? 25 * 1024 * 1024
  if ((message.fileSize ?? 0) > maximum) {
    throw new Error('media_too_large')
  }
  const external = message.contentProvider?.type === 'external'

  const url = external
    ? message.contentProvider?.originalContentUrl
    : `${config.contentApiBase}/v2/bot/message/${encodeURIComponent(message.id)}/content`

  if (!url) {
    throw new Error('missing_content_url')
  }

  const downloaded = await downloadMedia(url, {
    maxBytes: maximum,
    signal: AbortSignal.timeout(10_000),
    ...(!external
      ? {
          trustedOrigins: [new URL(config.contentApiBase).origin],
          allowInsecureLocalhost: config.allowLoopback,
          headers: { authorization: `Bearer ${secret(config.accessToken)}` }
        }
      : {})
  })

  const mimeType =
    downloaded.mimeType === 'application/octet-stream'
      ? (fallbackMime[message.type] ?? downloaded.mimeType)
      : downloaded.mimeType

  return [
    {
      kind: mediaKind(mimeType),
      mimeType,
      fileName:
        message.fileName ?? `${message.id}.${mimeType.split('/')[1] ?? 'bin'}`,
      data: downloaded.data,
      ...(message.duration && ['audio', 'video'].includes(message.type)
        ? { durationMs: message.duration }
        : {})
    }
  ]
}

function previewError(input: SendInput): string | undefined {
  const preview = input.preview
  if (
    !preview ||
    !['image/jpeg', 'image/png'].includes(preview.reference.mimeType) ||
    preview.data.byteLength > 1_000_000
  ) {
    return 'media_requires_jpeg_png_preview'
  }
  return undefined
}

export function mediaError(
  input: SendInput,
  host: ChannelHost
): string | undefined {
  if (!input.chunk.media) {
    return undefined
  }
  if (!host.media) {
    return 'public_media_unavailable'
  }
  const media = input.media
  if (!media) {
    return 'missing_media'
  }
  if (media.data.byteLength > (host.maxMediaBytes ?? 25 * 1024 * 1024)) {
    return 'media_too_large'
  }
  switch (media.reference.kind) {
    case 'image': {
      if (
        !['image/jpeg', 'image/png'].includes(media.reference.mimeType) ||
        media.data.byteLength > 10_000_000
      ) {
        return 'image_format_or_size_unsupported'
      }
      return media.data.byteLength > 1_000_000 ? previewError(input) : undefined
    }
    case 'audio': {
      if (
        !['audio/mpeg', 'audio/mp4', 'audio/x-m4a'].includes(
          media.reference.mimeType
        ) ||
        !media.reference.durationMs ||
        media.data.byteLength > 200_000_000
      ) {
        return 'audio_requires_mp3_m4a_duration'
      }
      return undefined
    }
    case 'video': {
      if (
        media.reference.mimeType !== 'video/mp4' ||
        media.data.byteLength > 200_000_000
      ) {
        return 'video_format_or_size_unsupported'
      }
      return previewError(input)
    }
    case 'file': {
      return 'native_file_send_unsupported'
    }
  }
  return undefined
}

export async function messages(
  input: SendInput,
  host: ChannelHost
): Promise<Json[]> {
  if (!input.chunk.media) {
    return [{ type: 'text', text: input.chunk.text }]
  }
  if (!input.media || !host.media) {
    throw new Error('public_media_unavailable')
  }
  const media = input.media.reference

  const originalContentUrl = await host.media.publish({
    requestId: input.requestId,
    mediaId: media.id
  })

  const message: Record<string, Json> = { type: media.kind, originalContentUrl }
  if (media.kind === 'audio') {
    message.duration = media.durationMs ?? 0
  } else {
    message.previewImageUrl = input.preview
      ? await host.media.publish({
          requestId: input.requestId,
          mediaId: input.preview.reference.id
        })
      : originalContentUrl
  }
  return input.chunk.text
    ? [{ type: 'text', text: input.chunk.text }, message]
    : [message]
}
