import { createDecipheriv } from 'node:crypto'
import { downloadMedia } from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaUpload,
  SendResult,
  StoredMedia
} from '@relanox/sdk'
import { z } from 'zod'
import type { messageSchema } from './schemas.js'

export const resourceSchema = z.object({
  url: z.url(),
  aeskey: z.string().min(1).optional(),
  filename: z.string().optional()
})

function contentType(data: Uint8Array, kind: MediaUpload['kind']): string {
  const bytes = Buffer.from(data)
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'image/png'
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    return 'image/jpeg'
  }
  if (bytes.subarray(0, 3).toString() === 'GIF') {
    return 'image/gif'
  }
  if (bytes.subarray(4, 8).toString() === 'ftyp') {
    return 'video/mp4'
  }
  if (kind !== 'file') {
    throw new Error('unsupported_media_format')
  }
  return 'application/octet-stream'
}

export async function receiveResource(
  resource: z.infer<typeof resourceSchema>,
  kind: MediaUpload['kind'],
  host: ChannelHost,
  signal: AbortSignal,
  fallbackKey?: string
): Promise<MediaUpload> {
  const maximum = host.maxMediaBytes ?? 25 * 1024 * 1024

  const downloaded = await downloadMedia(resource.url, {
    maxBytes: maximum + 32,
    signal,
    trustedOrigins: [],
    allowInsecureLocalhost: false
  })

  const key = Buffer.from(resource.aeskey ?? fallbackKey ?? '', 'base64')
  if (key.byteLength !== 32) {
    throw new Error('invalid_media_key')
  }
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)

  const padded = Buffer.concat([
    decipher.update(downloaded.data),
    decipher.final()
  ])

  const padding = padded.at(-1) ?? 0
  if (
    padding < 1 ||
    padding > 32 ||
    !padded.subarray(-padding).every((byte) => byte === padding)
  ) {
    throw new Error('invalid_media_padding')
  }
  const data = padded.subarray(0, -padding)
  if (data.byteLength > maximum) {
    throw new Error('media_too_large')
  }
  const mimeType = contentType(data, kind)
  const extension = mimeType.split('/')[1] ?? 'bin'
  return {
    kind,
    mimeType,
    data,
    fileName: resource.filename ?? `attachment.${extension}`
  }
}

type UploadRequest = (
  cmd: string,
  body: unknown,
  signal: AbortSignal
) => Promise<{ errcode?: number | undefined; body?: unknown }>

export async function uploadResource(
  media: StoredMedia,
  request: UploadRequest,
  signal: AbortSignal
): Promise<string> {
  const { kind, mimeType, fileName } = media.reference
  const maximum = { audio: 2, file: 20, image: 10, video: 10 }[kind]

  const formats: Record<string, readonly string[]> = {
    image: ['image/png', 'image/jpeg', 'image/gif'],
    audio: ['audio/amr'],
    video: ['video/mp4']
  }

  if (
    media.data.byteLength < 5 ||
    media.data.byteLength > maximum * 1024 * 1024 ||
    Buffer.byteLength(fileName) > 256
  ) {
    throw new Error('unsupported_media_size')
  }
  if (kind !== 'file' && !formats[kind]?.includes(mimeType)) {
    throw new Error('unsupported_media_format')
  }
  const chunkSize = 512 * 1024
  const type = kind === 'audio' ? 'voice' : kind

  const init = await request(
    'aibot_upload_media_init',
    {
      type,
      filename: fileName,
      total_size: media.data.byteLength,
      total_chunks: Math.ceil(media.data.byteLength / chunkSize)
    },
    signal
  )

  if (init.errcode !== 0) {
    throw new Error('media_upload_failed')
  }

  const uploadId = z
    .object({ upload_id: z.string().min(1) })
    .parse(init.body).upload_id

  for (let offset = 0; offset < media.data.byteLength; offset += chunkSize) {
    const response = await request(
      'aibot_upload_media_chunk',
      {
        upload_id: uploadId,
        chunk_index: offset / chunkSize,
        base64_data: Buffer.from(
          media.data.subarray(offset, offset + chunkSize)
        ).toString('base64')
      },
      signal
    )

    if (response.errcode !== 0) {
      throw new Error('media_upload_failed')
    }
  }

  const finish = await request(
    'aibot_upload_media_finish',
    { upload_id: uploadId },
    signal
  )

  if (finish.errcode !== 0) {
    throw new Error('media_upload_failed')
  }
  return z.object({ media_id: z.string().min(1) }).parse(finish.body).media_id
}

export async function receiveParts(
  message: z.infer<typeof messageSchema>,
  host: ChannelHost,
  signal: AbortSignal,
  fallbackKey?: string
): Promise<{ text: string; attachments: MediaUpload[] }> {
  const attachments: MediaUpload[] = []

  let text =
    message.msgtype === 'text'
      ? (message.text?.content ?? '')
      : (message.voice?.content ?? '')

  const items = message.mixed?.msg_item ?? [message]
  for (const item of items) {
    if (message.msgtype === 'mixed' && item.text) {
      text += item.text.content
    }
    for (const kind of ['image', 'file', 'video'] as const) {
      const resource = item[kind]
      if (resource) {
        attachments.push(
          await receiveResource(resource, kind, host, signal, fallbackKey)
        )
      }
    }
  }
  return { text, attachments }
}

export function outgoingBody(
  media: StoredMedia | undefined,
  mediaId: string | undefined,
  content: string
):
  | { msgtype: string; markdown: { content: string } }
  | {
      [x: string]: string | { description?: string; media_id: string }
      msgtype: string
      markdown?: never
    } {
  if (!media || !mediaId) {
    return { msgtype: 'markdown', markdown: { content } }
  }
  const type = media.reference.kind === 'audio' ? 'voice' : media.reference.kind
  return {
    msgtype: type,
    [type]: {
      media_id: mediaId,
      ...(type === 'video' ? { description: content } : {})
    }
  }
}

export function uploadFailure(error: unknown): SendResult {
  const invalid = new Set([
    'unsupported_media_size',
    'unsupported_media_format',
    'missing_media'
  ])

  if (error instanceof Error && invalid.has(error.message)) {
    return { status: 'rejected', errorCode: error.message }
  }
  return {
    status: 'retryable',
    errorCode: 'media_upload_unavailable',
    retryAfterMs: 1000
  }
}
