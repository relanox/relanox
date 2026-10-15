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
import { MsgType } from 'matrix-js-sdk'
import type { MessageContent } from './client.js'
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

function contentUri(value: string): { server: string; id: string } {
  const match = /^mxc:\/\/(?<server>[^/?#@\s]+)\/(?<id>[A-Za-z0-9_-]+)$/u.exec(
    value
  )?.groups

  if (!match?.server || !match.id) {
    throw new Error('invalid_media_uri')
  }
  return { server: match.server, id: match.id }
}

export async function receiveMedia(
  content: unknown,
  host: ChannelHost,
  config: MatrixConfig,
  base: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<MediaUpload[]> {
  if (content !== null && typeof content === 'object' && 'file' in content) {
    throw new Error('encrypted_unsupported')
  }
  const parsed = mediaSchema.safeParse(content)
  if (!parsed.success) {
    return []
  }
  const data = parsed.data
  const uri = contentUri(data.url)

  const downloaded = await downloadMedia(
    `${base}/_matrix/client/v1/media/download/${encodeURIComponent(uri.server)}/${encodeURIComponent(uri.id)}`,
    {
      maxBytes: host.maxMediaBytes ?? 100 * 1024 * 1024,
      signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
      headers,
      trustedOrigins: [new URL(base).origin],
      allowInsecureLocalhost: config.allowInsecureLocalhost
    }
  )

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

    contentUri(result.content_uri)
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
): Promise<SendResult | MessageContent> {
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
    return {
      msgtype: MsgType.Text,
      body: input.chunk.text,
      format: 'org.matrix.custom.html',
      formatted_body: renderHtml(input.chunk.text)
    }
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

  switch (media.reference.kind) {
    case 'image': {
      return { ...content, msgtype: MsgType.Image }
    }
    case 'audio': {
      return { ...content, msgtype: MsgType.Audio }
    }
    case 'video': {
      return { ...content, msgtype: MsgType.Video }
    }
    case 'file': {
      return { ...content, msgtype: MsgType.File }
    }
  }
  throw new Error('unsupported_media')
}
