import { REQUEST_TIMEOUT_MS } from './config.js'
import { downloadMedia, mediaBlob, mediaKind } from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaUpload,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { z } from 'zod'
import type { TelegramConfig } from './config.js'
import { sendOutcome } from './client.js'
import type { updateSchema } from './schemas.js'
import { jsonResponse, postJson } from './transport.js'

type Message = NonNullable<z.infer<typeof updateSchema>['message']>

export function hasMedia(message: Message): boolean {
  return selectedFile(message) !== undefined
}

function selectedFile(message: Message):
  | {
      [x: string]: unknown
      file_id: string
      file_size?: number | undefined
      file_name?: string | undefined
      mime_type?: string | undefined
      duration?: number | undefined
    }
  | undefined {
  return (
    message.photo?.at(-1) ??
    message.audio ??
    message.voice ??
    message.video ??
    message.animation ??
    message.video_note ??
    message.document
  )
}

function fallbackMime(message: Message): string {
  if (message.photo?.length) {
    return 'image/jpeg'
  }
  if (message.voice) {
    return 'audio/ogg'
  }
  if (message.audio) {
    return 'audio/mpeg'
  }
  if (message.video ?? message.animation ?? message.video_note) {
    return 'video/mp4'
  }
  return 'application/octet-stream'
}

function codepointLength(text: string): number {
  return text.match(/[\s\S]/gu)?.length ?? 0
}

export async function receiveMedia(
  message: Message,
  host: ChannelHost,
  config: TelegramConfig,
  token: string
): Promise<MediaUpload[]> {
  const file = selectedFile(message)
  if (!file) {
    return []
  }

  const maximum = Math.min(
    host.maxMediaBytes ?? 25 * 1024 * 1024,
    20 * 1024 * 1024
  )

  if ((file.file_size ?? 0) > maximum) {
    throw new Error('media_too_large')
  }
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const base = config.apiBaseUrl.replace(/\/$/u, '')

  const response = await postJson(
    `${base}/bot${token}/getFile`,
    {},
    { file_id: file.file_id },
    signal,
    REQUEST_TIMEOUT_MS
  )

  const result = z
    .looseObject({
      ok: z.literal(true),
      result: z.looseObject({
        file_path: z.string().min(1),
        file_size: z.number().optional()
      })
    })
    .parse(await jsonResponse(response))

  if (!response.ok || (result.result.file_size ?? 0) > maximum) {
    throw new Error('media_download_failed')
  }
  const path = result.result.file_path
  if (
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    !/^[A-Za-z0-9_./-]+$/u.test(path)
  ) {
    throw new Error('invalid_file_path')
  }

  const downloaded = await downloadMedia(`${base}/file/bot${token}/${path}`, {
    maxBytes: maximum,
    signal,
    trustedOrigins: [new URL(base).origin],
    allowInsecureLocalhost: config.allowInsecureLoopback
  })

  const fallback = fallbackMime(message)

  const mimeType =
    file.mime_type ??
    (downloaded.mimeType === 'application/octet-stream'
      ? fallback
      : downloaded.mimeType)

  return [
    {
      kind: mediaKind(mimeType),
      mimeType,
      fileName: file.file_name ?? path.split('/').at(-1) ?? 'attachment',
      data: downloaded.data,
      ...(file.duration === undefined
        ? {}
        : { durationMs: Math.round(file.duration * 1000) })
    }
  ]
}

export async function sendMedia(
  input: SendInput,
  host: ChannelHost,
  config: TelegramConfig,
  token: string
): Promise<SendResult> {
  const media = input.media
  if (!media) {
    return { status: 'rejected', errorCode: 'missing_media' }
  }
  const kind = media.reference.kind

  let field = {
    image: 'photo',
    audio: 'audio',
    video: 'video',
    file: 'document'
  }[kind]

  if (
    kind === 'audio' &&
    ['audio/ogg', 'audio/opus'].includes(media.reference.mimeType)
  ) {
    field = 'voice'
  }
  if (kind === 'image' && media.reference.mimeType === 'image/gif') {
    field = 'animation'
  }

  const maximum = Math.min(
    host.maxMediaBytes ?? 25 * 1024 * 1024,
    (kind === 'image' ? 10 : 50) * 1024 * 1024
  )

  if (
    media.data.byteLength > maximum ||
    codepointLength(input.chunk.text) > 1024
  ) {
    return { status: 'rejected', errorCode: 'media_limit_exceeded' }
  }
  const body = new FormData()
  body.set('chat_id', input.target.chatId)
  if (input.chunk.text) {
    body.set('caption', input.chunk.text)
  }
  if (input.target.threadId) {
    body.set('message_thread_id', input.target.threadId)
  }
  if (input.target.replyToId) {
    body.set(
      'reply_parameters',
      JSON.stringify({
        message_id: Number(input.target.replyToId),
        allow_sending_without_reply: true
      })
    )
  }
  if (
    media.reference.durationMs !== undefined &&
    ['audio', 'voice', 'video', 'animation'].includes(field)
  ) {
    body.set('duration', String(Math.ceil(media.reference.durationMs / 1000)))
  }
  body.set(field, mediaBlob(media), media.reference.fileName)

  const response = await fetch(
    `${config.apiBaseUrl.replace(/\/$/u, '')}/bot${token}/send${field[0]?.toUpperCase()}${field.slice(1)}`,
    {
      method: 'POST',
      body,
      signal: AbortSignal.any([
        input.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      ]),
      redirect: 'error'
    }
  )

  return sendOutcome(response)
}
