import { requestTimeoutMs } from './constants.js'
import { downloadMedia, mediaBlob } from '@relanox/channel-media'
import { renderHtml } from '@relanox/markdown'
import { richContent } from './rich.js'
import type {
  ChannelHost,
  MediaUpload,
  SendInput,
  SendResult
} from '@relanox/sdk'
import type { MatrixClient } from 'matrix-js-sdk'
import { ContentHelpers, MsgType } from 'matrix-js-sdk'
import type { MediaEventContent } from 'matrix-js-sdk/lib/@types/media.js'
import { z } from 'zod'
import type { MatrixConfig } from './config.js'
import { sendFailure } from './protocol.js'

const mediaSchema = z
  .object({
    msgtype: z.enum(['m.image', 'm.audio', 'm.video', 'm.file']),
    body: z
      .string()
      .min(1)
      .max(1024 * 1024),
    filename: z.string().min(1).max(255).optional(),
    url: z.string(),
    info: z
      .object({
        mimetype: z.string().optional(),
        duration: z.number().int().nonnegative().optional()
      })
      .optional()
  })
  .refine((value) => value.filename !== undefined || value.body.length <= 255)

const kinds = {
  'm.image': 'image',
  'm.audio': 'audio',
  'm.video': 'video',
  'm.file': 'file'
} as const

export async function receiveMedia(
  content: unknown,
  host: ChannelHost,
  config: MatrixConfig,
  client: MatrixClient,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<MediaUpload[]> {
  const parsed = mediaSchema.safeParse(content)
  if (!parsed.success) {
    return []
  }
  const data = parsed.data

  const url = client.mxcUrlToHttp(
    data.url,
    undefined,
    undefined,
    undefined,
    false,
    false,
    true
  )

  if (!url) {
    throw new Error('invalid_media_uri')
  }

  // SDK media conversion roots /_matrix at the origin, while its other APIs
  // Retain a configured homeserver path. Keep that deployment prefix here too.
  const homeserver = new URL(client.getHomeserverUrl())
  const downloadUrl = new URL(url)
  downloadUrl.pathname = `${homeserver.pathname.replace(/\/$/u, '')}${downloadUrl.pathname}`

  const downloaded = await downloadMedia(downloadUrl.href, {
    maxBytes: host.maxMediaBytes ?? 100 * 1024 * 1024,
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
    headers,
    trustedOrigins: [homeserver.origin],
    allowInsecureLocalhost: config.allowInsecureLocalhost
  })

  return [
    {
      kind: kinds[data.msgtype],
      fileName: data.filename ?? data.body,
      mimeType: data.info?.mimetype ?? downloaded.mimeType,
      data: downloaded.data,
      // Native clients may report zero; Core stores positive durations only.
      ...(!data.info?.duration ? {} : { durationMs: data.info.duration })
    }
  ]
}

export function mediaCaption(content: unknown): string {
  const parsed = mediaSchema.safeParse(content)
  return parsed.success &&
    parsed.data.filename &&
    parsed.data.body !== parsed.data.filename
    ? parsed.data.body
    : ''
}

async function upload(
  client: MatrixClient,
  media: NonNullable<SendInput['media']>
): Promise<string | SendResult> {
  try {
    const result = await client.uploadContent(mediaBlob(media), {
      name: media.reference.fileName,
      type: media.reference.mimeType
    })

    if (!client.mxcUrlToHttp(result.content_uri)) {
      throw new Error('invalid_media_uri')
    }
    return result.content_uri
  } catch (error) {
    const failure = sendFailure(error)
    // Uploading a blob cannot deliver a room message. Retrying it is safe.
    return failure.status === 'unknown'
      ? { status: 'retryable', errorCode: 'media_upload_failed' }
      : failure
  }
}

export async function messageContent(
  input: SendInput,
  client: MatrixClient
): Promise<SendResult | ReturnType<typeof richContent> | MediaEventContent> {
  if (input.chunk.richText) {
    const urls: string[] = []
    for (const media of input.richMedia ?? []) {
      const uploaded = await upload(client, media)
      if (typeof uploaded !== 'string') {
        return uploaded
      }
      urls.push(uploaded)
    }
    const content = richContent(input, urls)
    // Leave room for the event envelope and thread relation below Matrix's event budget.
    if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 60_000) {
      return { status: 'rejected', errorCode: 'rich_message_limit_exceeded' }
    }
    return content
  }
  if (!input.media) {
    // MakeHtmlMessage always creates m.text, despite its broader SDK return type.
    return ContentHelpers.makeHtmlMessage(
      input.chunk.text,
      renderHtml(input.chunk.text)
    ) as ReturnType<typeof richContent>
  }
  const media = input.media
  const url = await upload(client, media)
  if (typeof url !== 'string') {
    return url
  }

  const thumbnailUrl = input.preview
    ? await upload(client, input.preview)
    : undefined

  if (thumbnailUrl !== undefined && typeof thumbnailUrl !== 'string') {
    return thumbnailUrl
  }

  const content = {
    body: media.reference.fileName,
    filename: media.reference.fileName,
    url,
    info: {
      mimetype: media.reference.mimeType,
      size: media.reference.size,
      ...(media.reference.durationMs === undefined
        ? {}
        : { duration: media.reference.durationMs }),
      ...(thumbnailUrl && input.preview
        ? {
            thumbnail_url: thumbnailUrl,
            thumbnail_info: {
              mimetype: input.preview.reference.mimeType,
              size: input.preview.reference.size
            }
          }
        : {})
    }
  }

  const types = {
    image: MsgType.Image,
    audio: MsgType.Audio,
    video: MsgType.Video,
    file: MsgType.File
  } as const

  return { ...content, msgtype: types[media.reference.kind] }
}
