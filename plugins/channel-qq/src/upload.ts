import { Buffer } from 'node:buffer'
import { MediaFileType } from '@tencent-connect/qqbot-nodejs'
import type { QQBot, ReplyTarget } from '@tencent-connect/qqbot-nodejs'
import type { SendInput, SendResult } from '@relanox/sdk'
import { z } from 'zod'
import { apiError } from './api-error.js'

const formats: Readonly<Record<string, readonly string[]>> = {
  image: ['image/png', 'image/jpeg'],
  audio: ['audio/silk', 'audio/x-silk'],
  video: ['video/mp4']
}

export async function uploadMedia(
  input: SendInput,
  target: ReplyTarget,
  bot: QQBot
): Promise<string | SendResult | undefined> {
  if (!input.chunk.media) {
    return undefined
  }
  if (!input.media) {
    return { status: 'rejected', errorCode: 'missing_media' }
  }
  const { kind, mimeType, fileName } = input.media.reference
  if (kind !== 'file' && !formats[kind]?.includes(mimeType)) {
    return { status: 'rejected', errorCode: 'unsupported_media_format' }
  }

  const raw = await bot.uploadMedia({
    target,
    fileType: {
      image: MediaFileType.IMAGE,
      video: MediaFileType.VIDEO,
      audio: MediaFileType.VOICE,
      file: MediaFileType.FILE
    }[kind],
    buffer: Buffer.from(input.media.data),
    fileName,
    srvSendMsg: false
  })

  const failure = apiError(raw, true)
  if (failure) {
    return failure
  }
  return z
    .object({
      file_info: z.string().min(1),
      ttl: z.number().int().nonnegative()
    })
    .parse(raw).file_info
}
