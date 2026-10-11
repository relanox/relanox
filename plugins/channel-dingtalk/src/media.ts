import { downloadMedia, mediaBlob, mediaKind } from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaUpload,
  SendInput,
  SendResult,
  StoredMedia
} from '@relanox/sdk'
import { z } from 'zod'
import type { messageSchema } from './schemas.js'
import type { DingTalkConfig } from './config.js'
import { httpJson, jsonPostRequest } from './transport.js'

export const contentSchema = z.object({
  downloadCode: z.string().optional(),
  pictureDownloadCode: z.string().optional(),
  fileName: z.string().optional(),
  recognition: z.string().optional(),
  duration: z.number().optional(),
  richText: z
    .array(
      z.object({
        text: z.string().optional(),
        type: z.string().optional(),
        downloadCode: z.string().optional(),
        pictureDownloadCode: z.string().optional()
      })
    )
    .optional()
})

export async function downloadAttachment(
  content: z.infer<typeof contentSchema>,
  config: DingTalkConfig,
  host: ChannelHost,
  credential: string,
  signal: AbortSignal
): Promise<MediaUpload> {
  const code = content.downloadCode ?? content.pictureDownloadCode
  if (!code) {
    throw new Error('missing_download_code')
  }

  const response = await httpJson(
    `${config.apiBase.replace(/\/$/u, '')}/v1.0/robot/messageFiles/download`,
    jsonPostRequest(
      { downloadCode: code, robotCode: config.robotCode },
      { 'x-acs-dingtalk-access-token': credential }
    ),
    signal
  )

  const url = z.object({ downloadUrl: z.url() }).parse(response).downloadUrl

  const downloaded = await downloadMedia(url, {
    maxBytes: host.maxMediaBytes ?? 25 * 1024 * 1024,
    signal,
    trustedOrigins: config.mediaOrigins,
    allowInsecureLocalhost: config.allowInsecureLoopback
  })

  return {
    ...downloaded,
    kind: mediaKind(downloaded.mimeType),
    fileName:
      content.fileName ??
      new URL(url).pathname.split('/').at(-1) ??
      'attachment.bin',
    ...(content.duration ? { durationMs: content.duration } : {})
  }
}

async function upload(
  media: StoredMedia,
  config: DingTalkConfig,
  credential: string,
  signal: AbortSignal
): Promise<string> {
  const { kind, mimeType } = media.reference

  const formats: Record<string, readonly string[]> = {
    image: ['image/png', 'image/jpeg', 'image/gif', 'image/bmp'],
    audio: ['audio/amr'],
    video: ['video/mp4']
  }

  if (
    (kind !== 'file' && !formats[kind]?.includes(mimeType)) ||
    media.data.byteLength > (kind === 'audio' ? 2 : 20) * 1024 * 1024
  ) {
    throw new Error('unsupported_media_format_or_size')
  }
  const url = new URL(`${config.uploadBase.replace(/\/$/u, '')}/media/upload`)
  url.searchParams.set('access_token', credential)
  url.searchParams.set('type', kind === 'audio' ? 'voice' : kind)
  const form = new FormData()
  form.set('media', mediaBlob(media), media.reference.fileName)

  const response = await httpJson(
    url.href,
    { method: 'POST', body: form },
    signal
  )

  const result = z
    .object({ errcode: z.number().optional(), media_id: z.string().optional() })
    .parse(response)

  if (result.errcode && result.errcode !== 0) {
    throw new Error('media_upload_failed')
  }
  if (!result.media_id) {
    throw new Error('media_upload_failed')
  }
  return result.media_id
}

export async function mediaMessage(
  input: SendInput,
  config: DingTalkConfig,
  credential: string
): Promise<{ msgKey: string; msgParam: string }> {
  if (!input.chunk.media) {
    return {
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: input.chunk.text })
    }
  }
  if (!input.media) {
    throw new Error('missing_media')
  }
  const { kind, fileName, durationMs } = input.media.reference
  if ((kind === 'audio' || kind === 'video') && !durationMs) {
    throw new Error('missing_media_duration')
  }
  if (kind === 'video' && !input.preview) {
    throw new Error('missing_video_preview')
  }
  if (
    kind === 'file' &&
    !['xlsx', 'pdf', 'zip', 'rar', 'doc', 'docx'].includes(
      fileName.split('.').at(-1)?.toLowerCase() ?? ''
    )
  ) {
    throw new Error('unsupported_file_format')
  }
  const mediaId = await upload(input.media, config, credential, input.signal)
  if (kind === 'image') {
    return {
      msgKey: 'sampleImageMsg',
      msgParam: JSON.stringify({ photoURL: mediaId })
    }
  }
  if (kind === 'audio') {
    return {
      msgKey: 'sampleAudio',
      msgParam: JSON.stringify({ mediaId, duration: String(durationMs) })
    }
  }
  if (kind === 'video' && input.preview) {
    const picMediaId = await upload(
      input.preview,
      config,
      credential,
      input.signal
    )

    return {
      msgKey: 'sampleVideo',
      msgParam: JSON.stringify({
        videoMediaId: mediaId,
        picMediaId,
        videoType: 'mp4',
        duration: String(Math.ceil((durationMs ?? 0) / 1000))
      })
    }
  }
  return {
    msgKey: 'sampleFile',
    msgParam: JSON.stringify({
      mediaId,
      fileName,
      fileType: fileName.split('.').at(-1)
    })
  }
}

export async function receiveParts(
  message: z.infer<typeof messageSchema>,
  config: DingTalkConfig,
  host: ChannelHost,
  credential: string | undefined,
  signal: AbortSignal
): Promise<{ text: string; attachments: MediaUpload[] }> {
  const attachments: MediaUpload[] = []
  let text = message.text?.content ?? message.content?.recognition ?? ''
  if (message.msgtype === 'text') {
    return { text, attachments }
  }
  if (!credential) {
    throw new Error('media_oauth_unavailable')
  }

  const items =
    message.content?.richText ?? (message.content ? [message.content] : [])

  for (const item of items) {
    if ('text' in item && item.text) {
      text += item.text
    }
    if (item.downloadCode || item.pictureDownloadCode) {
      attachments.push(
        await downloadAttachment(item, config, host, credential, signal)
      )
    }
  }
  if (!text && attachments.length === 0) {
    throw new Error('missing_media_content')
  }
  return { text, attachments }
}

export function uploadFailure(error: unknown): SendResult {
  const invalid = new Set([
    'unsupported_media_format_or_size',
    'missing_media',
    'missing_media_duration',
    'missing_video_preview',
    'unsupported_file_format'
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
