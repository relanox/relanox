import { API_VERSION, API_BASE, validateEndpointUrl } from './config.js'
import {
  downloadMedia,
  mediaBlob,
  MediaDownloadError
} from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaKind,
  MediaUpload,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { z } from 'zod'
import type { WhatsAppConfig } from './config.js'
import { failure, request, secret } from './io.js'
import type { messageSchema } from './schemas.js'

const formats: Record<
  MediaKind,
  { limit: number; mimeTypes: readonly string[] }
> = {
  image: { limit: 5 * 1000 * 1000, mimeTypes: ['image/jpeg', 'image/png'] },
  audio: {
    limit: 16 * 1000 * 1000,
    mimeTypes: [
      'audio/aac',
      'audio/amr',
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg'
    ]
  },
  video: { limit: 16 * 1000 * 1000, mimeTypes: ['video/mp4', 'video/3gpp'] },
  file: {
    limit: 100 * 1000 * 1000,
    mimeTypes: [
      'text/plain',
      'application/pdf',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ]
  }
}

const mediaType = z.enum(['image', 'audio', 'video', 'document'])

const metadataSchema = z.object({
  id: z.string(),
  url: z.url(),
  mime_type: z.string().min(1).max(128),
  file_size: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[0-9]+$/u)
        .transform(Number)
    ])
    .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
})

async function readMediaJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('empty_media_response')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) {
        break
      }
      size += part.value.byteLength
      if (size > 64 * 1024) {
        throw new Error('media_response_too_large')
      }
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function receiveMedia(
  message: z.infer<typeof messageSchema>,
  host: ChannelHost,
  config: WhatsAppConfig,
  signal: AbortSignal
): Promise<{ text: string; attachments: MediaUpload[] }> {
  const type = mediaType.safeParse(message.type)
  if (!type.success) {
    return {
      text: message.type === 'text' ? (message.text?.body ?? '') : '',
      attachments: []
    }
  }
  const bound = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  const payload = message[type.data]
  if (!payload) {
    throw new Error('invalid_media_message')
  }

  const endpoint = new URL(
    `${API_BASE}/${API_VERSION}/${encodeURIComponent(payload.id)}`
  )

  endpoint.searchParams.set('phone_number_id', config.phoneNumberId)
  const authorization = `Bearer ${secret(config.accessToken)}`

  const response = await request(
    validateEndpointUrl(endpoint.href, false),
    { headers: { authorization } },
    bound
  )

  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('media_metadata_failed')
  }
  const metadata = metadataSchema.parse(await readMediaJson(response))
  const url = new URL(metadata.url)
  const configuredOrigin = new URL(API_BASE).origin
  if (
    metadata.id !== payload.id ||
    (url.origin !== configuredOrigin &&
      url.origin !== 'https://lookaside.fbsbx.com')
  ) {
    throw new Error('unsafe_media_origin')
  }
  const kind = type.data === 'document' ? 'file' : type.data
  const mimeType = metadata.mime_type.split(';')[0]?.trim().toLowerCase() ?? ''

  const maximum = Math.min(
    host.maxMediaBytes ?? 16 * 1024 * 1024,
    formats[kind].limit
  )

  if (!formats[kind].mimeTypes.includes(mimeType)) {
    throw new Error('unsupported_media')
  }
  if (metadata.file_size > maximum) {
    throw new MediaDownloadError('media_too_large')
  }

  const downloaded = await downloadMedia(metadata.url, {
    maxBytes: maximum,
    signal: bound,
    headers: { authorization },
    trustedOrigins: [configuredOrigin, 'https://lookaside.fbsbx.com'],
    allowInsecureLocalhost: false
  })

  return {
    text: payload.caption ?? '',
    attachments: [
      {
        kind,
        mimeType,
        fileName:
          payload.filename ?? `${type.data}.${mimeType.split('/')[1] ?? 'bin'}`,
        data: downloaded.data
      }
    ]
  }
}

export async function uploadMedia(
  input: SendInput,
  config: WhatsAppConfig
): Promise<
  | {
      type: 'image' | 'audio' | 'video' | 'document'
      value: { id: string; filename?: string }
    }
  | SendResult
> {
  const media = input.media
  if (!media) {
    throw new Error('media_missing')
  }
  const format = formats[media.reference.kind]
  if (!format.mimeTypes.includes(media.reference.mimeType)) {
    return { status: 'rejected', errorCode: 'media_format_unsupported' }
  }
  if (media.data.byteLength > format.limit) {
    return { status: 'rejected', errorCode: 'media_too_large' }
  }
  const form = new FormData()
  form.set('messaging_product', 'whatsapp')
  form.set('type', media.reference.mimeType)
  form.set('file', mediaBlob(media), media.reference.fileName)
  let response
  try {
    response = await request(
      validateEndpointUrl(
        `${API_BASE}/${API_VERSION}/${encodeURIComponent(config.phoneNumberId)}/media`,
        false
      ),
      {
        method: 'POST',
        headers: { authorization: `Bearer ${secret(config.accessToken)}` },
        body: form
      },
      input.signal
    )
  } catch {
    return { status: 'retryable', errorCode: 'media_upload_failed' }
  }
  if (!response.ok) {
    const result = await failure(response)
    return result.status === 'unknown'
      ? { status: 'retryable', errorCode: 'media_upload_failed' }
      : result
  }
  try {
    const uploaded = z
      .object({ id: z.string().min(1).max(1024) })
      .parse(await readMediaJson(response))

    return {
      type: media.reference.kind === 'file' ? 'document' : media.reference.kind,
      value: {
        id: uploaded.id,
        ...(media.reference.kind === 'file'
          ? { filename: media.reference.fileName }
          : {})
      }
    }
  } catch {
    return { status: 'retryable', errorCode: 'media_upload_response_invalid' }
  }
}
