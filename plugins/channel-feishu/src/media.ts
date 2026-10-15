import {
  downloadMedia,
  mediaKind,
  MediaDownloadError
} from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaUpload,
  SendInput,
  StoredMedia
} from '@relanox/sdk'
import type {
  LarkChannel,
  ResourceDescriptor,
  SendInput as NativeInput
} from '@larksuiteoapi/node-sdk'
import { REQUEST_TIMEOUT_MS } from './config.js'

export function isMediaSizeRejection(error: unknown): boolean {
  return error instanceof MediaDownloadError && error.code === 'media_too_large'
}

export function isMediaTokenRejection(error: unknown): boolean {
  return (
    error instanceof MediaDownloadError &&
    error.status !== undefined &&
    [400, 401].includes(error.status) &&
    typeof error.responseBody === 'object' &&
    error.responseBody !== null &&
    'code' in error.responseBody &&
    error.responseBody.code === 99_991_663
  )
}

export async function receiveMedia(
  messageId: string,
  resources: ResourceDescriptor[],
  host: ChannelHost,
  base: string,
  access: string
): Promise<MediaUpload[]> {
  return Promise.all(
    resources.map(async (resource) => {
      const downloaded = await downloadMedia(
        `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resource.fileKey)}?type=${resource.type === 'image' ? 'image' : 'file'}`,
        {
          maxBytes: host.maxMediaBytes ?? 100 * 1024 * 1024,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          trustedOrigins: [new URL(base).origin],
          allowInsecureLocalhost: false,
          headers: { authorization: `Bearer ${access}` }
        }
      )

      const fallback: Readonly<Record<string, string>> = {
        image: 'image/jpeg',
        audio: 'audio/ogg',
        video: 'video/mp4'
      }

      const mimeType =
        downloaded.mimeType === 'application/octet-stream'
          ? (fallback[resource.type] ?? downloaded.mimeType)
          : downloaded.mimeType

      return {
        kind: mediaKind(mimeType),
        mimeType,
        fileName: resource.fileName ?? resource.fileKey,
        data: downloaded.data,
        ...(resource.durationMs ? { durationMs: resource.durationMs } : {})
      }
    })
  )
}

async function imageKey(
  media: StoredMedia,
  channel: LarkChannel
): Promise<string> {
  const result = await channel.rawClient.im.v1.image.create({
    data: { image_type: 'message', image: Buffer.from(media.data) }
  })

  if (!result?.image_key) {
    throw new Error('missing_uploaded_key')
  }
  return result.image_key
}

export async function nativeContent(
  input: SendInput,
  channel: LarkChannel
): Promise<NativeInput> {
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
        input.signal.throwIfAborted()
        rows.push([{ tag: 'img', image_key: await imageKey(media, channel) }])
      }
    }
    return { post: { zh_cn: { content: rows } } }
  }
  if (!input.chunk.media) {
    return { markdown: input.chunk.text }
  }
  const media = input.media
  if (!media) {
    throw new Error('missing_media')
  }
  const source = Buffer.from(media.data)
  switch (media.reference.kind) {
    case 'image': {
      return { image: { source } }
    }
    case 'audio': {
      return {
        audio: {
          source,
          ...(media.reference.durationMs
            ? { duration: media.reference.durationMs }
            : {})
        }
      }
    }
    case 'video': {
      return {
        video: {
          source,
          ...(media.reference.durationMs
            ? { duration: media.reference.durationMs }
            : {}),
          ...(input.preview
            ? { coverImageKey: await imageKey(input.preview, channel) }
            : {})
        }
      }
    }
    case 'file': {
      return { file: { source, fileName: media.reference.fileName } }
    }
    default: {
      throw new Error('unsupported_media_kind')
    }
  }
}
