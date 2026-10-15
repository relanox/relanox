import { quotedText } from './markdown.js'
import { richError, richMessage } from './rich.js'
import { contentApiBase } from './constants.js'
import {
  downloadMedia,
  MediaDownloadError,
  mediaKind
} from '@relanox/channel-media'
import type { DownloadedMedia } from '@relanox/channel-media'
import { setTimeout as delay } from 'node:timers/promises'
import type { ChannelHost, MediaUpload, SendInput } from '@relanox/sdk'
import type { messagingApi } from '@line/bot-sdk'
import type { LineConfig } from './config.js'
import { secret } from './io.js'
import type { LineMessage as Message } from './schemas.js'

const fallbackMime: Readonly<Record<string, string>> = {
  image: 'image/jpeg',
  audio: 'audio/mp4',
  video: 'video/mp4',
  file: 'application/octet-stream'
}

async function nativeContent(
  url: string,
  maximum: number,
  config: LineConfig,
  signal: AbortSignal
): Promise<DownloadedMedia> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = await downloadMedia(url, {
      maxBytes: maximum,
      signal,
      trustedOrigins: [new URL(contentApiBase).origin],
      headers: { authorization: `Bearer ${secret(config.accessToken)}` }
    })

    if (content.status === 200) {
      return content
    }
    if (content.status !== 202) {
      throw new Error('media_content_unavailable')
    }
    if (attempt < 2) {
      await delay(500, undefined, { signal })
    }
  }
  throw new Error('media_content_preparing')
}

export async function receiveMedia(
  message: Message,
  host: ChannelHost,
  config: LineConfig
): Promise<MediaUpload[]> {
  if (message.type === 'text') {
    return []
  }
  const maximum = host.maxMediaBytes ?? 100 * 1024 * 1024
  if ((message.fileSize ?? 0) > maximum) {
    throw new MediaDownloadError('media_too_large')
  }
  const external = message.contentProvider?.type === 'external'

  const url = external
    ? message.contentProvider?.originalContentUrl
    : `${contentApiBase}/v2/bot/message/${encodeURIComponent(message.id)}/content`

  if (!url) {
    throw new Error('missing_content_url')
  }

  const signal = AbortSignal.timeout(10_000)

  const downloaded = external
    ? await downloadMedia(url, { maxBytes: maximum, signal })
    : await nativeContent(url, maximum, config, signal)

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
    !['image/jpeg', 'image/png'].includes(preview.reference.mimeType)
  ) {
    return 'media_requires_jpeg_png_preview'
  }
  return undefined
}

export function mediaError(
  input: SendInput,
  host: ChannelHost
): string | undefined {
  if (input.chunk.richText) {
    return richError(input, host)
  }
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
  switch (media.reference.kind) {
    case 'image': {
      if (!['image/jpeg', 'image/png'].includes(media.reference.mimeType)) {
        return 'image_format_or_size_unsupported'
      }
      return media.data.byteLength > 1000 * 1000
        ? previewError(input)
        : undefined
    }
    case 'audio': {
      if (
        !['audio/mpeg', 'audio/mp4', 'audio/x-m4a'].includes(
          media.reference.mimeType
        ) ||
        !media.reference.durationMs
      ) {
        return 'audio_requires_mp3_m4a_duration'
      }
      return undefined
    }
    case 'video': {
      if (media.reference.mimeType !== 'video/mp4') {
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

export { splitLineMarkdown } from './markdown.js'

export async function messages(
  input: SendInput,
  host: ChannelHost,
  quoteToken?: string
): Promise<messagingApi.Message[]> {
  if (input.chunk.richText) {
    return [await richMessage(input, host)]
  }
  if (!input.chunk.media) {
    return [quotedText(input.chunk.text, input.reply ? quoteToken : undefined)]
  }
  if (!input.media || !host.media) {
    throw new Error('public_media_unavailable')
  }
  const media = input.media.reference

  const originalContentUrl = await host.media.publish({
    channelId: input.channelId,
    mediaId: media.id
  })

  let message: messagingApi.Message
  if (media.kind === 'audio') {
    message = {
      type: 'audio',
      originalContentUrl,
      duration: media.durationMs ?? 0
    }
  } else {
    if (media.kind === 'file') {
      throw new Error('native_file_send_unsupported')
    }

    const previewImageUrl = input.preview
      ? await host.media.publish({
          channelId: input.channelId,
          mediaId: input.preview.reference.id
        })
      : originalContentUrl

    message = { type: media.kind, originalContentUrl, previewImageUrl }
  }
  return input.chunk.text
    ? [
        quotedText(input.chunk.text, input.reply ? quoteToken : undefined),
        message
      ]
    : [message]
}
