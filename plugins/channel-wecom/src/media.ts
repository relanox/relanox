import { decryptFile } from '@wecom/aibot-node-sdk'
import type { WSClient, SendMsgBody } from '@wecom/aibot-node-sdk'
import { downloadMedia, MediaDownloadError } from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaUpload,
  SendResult,
  StoredMedia
} from '@relanox/sdk'
import { z } from 'zod'
import { fileTypeFromBuffer } from 'file-type'
import type { messageSchema } from './schemas.js'

export const resourceSchema = z.object({
  url: z.url(),
  aeskey: z.string().min(1).optional(),
  filename: z.string().optional()
})

async function contentType(
  data: Uint8Array,
  kind: MediaUpload['kind']
): Promise<string> {
  const detected = await fileTypeFromBuffer(data)
  if (detected) {
    return detected.mime
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
  const maximum = host.maxMediaBytes ?? 100 * 1024 * 1024

  const downloaded = await downloadMedia(resource.url, {
    maxBytes: maximum + 32,
    signal,
    trustedOrigins: [],
    allowInsecureLocalhost: false
  })

  const data = decryptFile(
    Buffer.from(downloaded.data),
    resource.aeskey ?? fallbackKey ?? ''
  )

  if (data.byteLength > maximum) {
    throw new MediaDownloadError('media_too_large')
  }
  const mimeType = await contentType(data, kind)
  const extension = mimeType.split('/')[1] ?? 'bin'
  return {
    kind,
    mimeType,
    data,
    fileName:
      resource.filename ?? downloaded.fileName ?? `attachment.${extension}`
  }
}

export async function uploadResource(
  media: StoredMedia,
  client: WSClient
): Promise<string> {
  try {
    const result = await client.uploadMedia(Buffer.from(media.data), {
      type: media.reference.kind === 'audio' ? 'voice' : media.reference.kind,
      filename: media.reference.fileName
    })

    return result.media_id
  } catch (error) {
    // SDK 1.0.7 rejects more than 100 native 512 KiB chunks without a typed code.
    // Classify that SDK refusal after the call, rather than duplicating upload policy.
    if (Math.ceil(media.data.byteLength / (512 * 1024)) > 100) {
      throw new UploadProtocolError()
    }
    throw error
  }
}

class UploadProtocolError extends Error {
  override readonly name = 'UploadProtocolError'
}

export async function receiveParts(
  message: z.infer<typeof messageSchema>,
  host: ChannelHost,
  signal: AbortSignal,
  fallbackKey?: string
): Promise<{ text: string; attachments: MediaUpload[] }> {
  try {
    return await downloadParts(message, host, signal, fallbackKey)
  } catch (error) {
    if (
      !(error instanceof MediaDownloadError) ||
      error.code !== 'media_too_large'
    ) {
      throw error
    }
    host.observe.log('info', 'channel_input_discarded', {
      errorCode: error.code
    })
    return { text: '', attachments: [] }
  }
}

async function downloadParts(
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
): SendMsgBody {
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

export function nativeFailure(error: unknown): SendResult | undefined {
  const parsed = z.object({ errcode: z.number().int() }).safeParse(error)
  if (parsed.success) {
    const code = parsed.data.errcode
    return code === -1 || code === 45_009
      ? { status: 'retryable', errorCode: `wecom_${code}`, retryAfterMs: 1000 }
      : { status: 'rejected', errorCode: `wecom_${code}` }
  }
  const cause = error instanceof Error ? error.cause : undefined
  return cause === undefined ? undefined : nativeFailure(cause)
}

export function uploadFailure(error: unknown): SendResult {
  if (error instanceof UploadProtocolError) {
    return { status: 'rejected', errorCode: 'media_protocol_limit' }
  }
  return (
    nativeFailure(error) ?? {
      status: 'retryable',
      errorCode: 'media_upload_unavailable',
      retryAfterMs: 1000
    }
  )
}
