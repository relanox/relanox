import { REQUEST_TIMEOUT_MS } from './config.js'
import { downloadMedia, mediaBlob, mediaKind } from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaUpload,
  SendInput,
  StoredMedia
} from '@relanox/sdk'
import { z } from 'zod'
import type { FeishuConfig } from './config.js'
import { jsonResponse } from './transport.js'

import type { InboundContent } from './inbound-content.js'

export { parseContent } from './inbound-content.js'

const nativeType = {
  image: 'image',
  audio: 'audio',
  video: 'media',
  file: 'file'
}

const fileType = {
  image: 'stream',
  audio: 'opus',
  video: 'mp4',
  file: 'stream'
}

export async function receiveMedia(
  messageId: string,
  content: InboundContent,
  host: ChannelHost,
  config: FeishuConfig,
  base: string,
  access: string
): Promise<MediaUpload[]> {
  return Promise.all(
    content.resources.map(async (resource) => {
      const downloaded = await downloadMedia(
        `${base.replace(/\/$/u, '')}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resource.key)}?type=${resource.type}`,
        {
          maxBytes: Math.min(
            host.maxMediaBytes ?? 25 * 1024 * 1024,
            100 * 1024 * 1024
          ),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          trustedOrigins: [new URL(base).origin],
          allowInsecureLocalhost: false,
          headers: { authorization: `Bearer ${access}` }
        }
      )

      const mimeType =
        downloaded.mimeType === 'application/octet-stream'
          ? resource.fallbackMime
          : downloaded.mimeType

      return {
        kind: mediaKind(mimeType),
        mimeType,
        fileName: resource.fileName ?? resource.key,
        data: downloaded.data,
        ...(resource.durationMs ? { durationMs: resource.durationMs } : {})
      }
    })
  )
}

const uploadSchema = z.looseObject({
  code: z.literal(0),
  data: z.looseObject({
    image_key: z.string().optional(),
    file_key: z.string().optional()
  })
})

async function uploadAsset(
  media: StoredMedia,
  host: ChannelHost,
  config: FeishuConfig,
  base: string,
  access: string,
  signal: AbortSignal
): Promise<string> {
  const image = media.reference.kind === 'image'
  if (
    media.data.byteLength >
    Math.min(
      host.maxMediaBytes ?? 25 * 1024 * 1024,
      (image ? 10 : 30) * 1024 * 1024
    )
  ) {
    throw new Error('media_too_large')
  }
  const body = new FormData()
  if (image) {
    body.set('image_type', 'message')
  } else {
    body.set('file_type', fileType[media.reference.kind])
    body.set('file_name', media.reference.fileName)
    if (media.reference.durationMs) {
      body.set('duration', String(media.reference.durationMs))
    }
  }
  body.set(image ? 'image' : 'file', mediaBlob(media), media.reference.fileName)

  const response = await fetch(
    `${base.replace(/\/$/u, '')}/open-apis/im/v1/${image ? 'images' : 'files'}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${access}` },
      body,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      ]),
      redirect: 'error'
    }
  )

  const uploaded = uploadSchema.parse(await jsonResponse(response))
  if (!response.ok) {
    throw new Error('media_upload_failed')
  }
  const key = image ? uploaded.data.image_key : uploaded.data.file_key
  if (!key) {
    throw new Error('missing_uploaded_key')
  }
  return key
}

export function mediaError(
  input: SendInput,
  host: ChannelHost
): string | undefined {
  if (!input.chunk.media) {
    return undefined
  }
  const media = input.media
  if (!media) {
    return 'missing_media'
  }
  if (input.chunk.text) {
    return 'media_caption_unsupported'
  }
  if (
    media.data.byteLength >
    Math.min(
      host.maxMediaBytes ?? 25 * 1024 * 1024,
      (media.reference.kind === 'image' ? 10 : 30) * 1024 * 1024
    )
  ) {
    return 'media_too_large'
  }
  if (
    media.reference.kind === 'video' &&
    (media.reference.mimeType !== 'video/mp4' || !media.reference.durationMs)
  ) {
    return 'video_requires_mp4_duration'
  }
  if (
    media.reference.kind === 'audio' &&
    (!['audio/ogg', 'audio/opus'].includes(media.reference.mimeType) ||
      !media.reference.durationMs)
  ) {
    return 'audio_requires_opus_duration'
  }
  return undefined
}

export async function messageContent(
  input: SendInput,
  host: ChannelHost,
  config: FeishuConfig,
  base: string,
  access: string
): Promise<{ msg_type: string; content: string }> {
  if (input.chunk.richText) {
    const rows: Record<string, string>[][] = []
    let imageIndex = 0
    for (const part of input.chunk.richText) {
      if (part.type === 'text') {
        rows.push([{ tag: 'md', text: part.text }])
      } else {
        const media = input.richMedia?.[imageIndex++]
        if (!media) {
          throw new Error('missing_media')
        }

        const key = await uploadAsset(
          media,
          host,
          config,
          base,
          access,
          input.signal
        )

        rows.push([{ tag: 'img', image_key: key }])
      }
    }
    return {
      msg_type: 'post',
      content: JSON.stringify({ zh_cn: { content: rows } })
    }
  }
  if (!input.chunk.media) {
    return {
      msg_type: 'post',
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'md', text: input.chunk.text }]] }
      })
    }
  }
  const media = input.media
  if (!media) {
    throw new Error('missing_media')
  }
  const key = await uploadAsset(media, host, config, base, access, input.signal)

  const content: Record<string, string> =
    media.reference.kind === 'image' ? { image_key: key } : { file_key: key }

  if (input.preview && media.reference.kind === 'video') {
    content.image_key = await uploadAsset(
      input.preview,
      host,
      config,
      base,
      access,
      input.signal
    )
  }
  return {
    msg_type: nativeType[media.reference.kind],
    content: JSON.stringify(content)
  }
}
