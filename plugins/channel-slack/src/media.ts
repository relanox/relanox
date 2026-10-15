import { slackMarkdown } from './markdown.js'
import { REQUEST_TIMEOUT_MS, API_BASE_URL } from './config.js'
import {
  downloadMedia,
  mediaKind,
  MediaDownloadError
} from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaUpload,
  SendInput,
  SendResult,
  StoredMedia
} from '@relanox/sdk'
import type { WebClient } from '@slack/web-api'
import type { KnownBlock } from '@slack/types'
import { fileSchema } from './schemas.js'
import type { messageSchema } from './schemas.js'
import type { z } from 'zod'
import { sdkFailure } from './client.js'

export { MediaDownloadError } from '@relanox/channel-media'

export async function receiveMedia(
  files: z.infer<typeof messageSchema>['files'],
  host: ChannelHost,
  token: string,
  client: WebClient
): Promise<MediaUpload[]> {
  return Promise.all(
    files.map(async (eventFile) => {
      const file =
        eventFile.url_private_download || eventFile.url_private
          ? eventFile
          : fileSchema.parse(
              (await client.files.info({ file: eventFile.id })).file
            )

      if (file.id !== eventFile.id) {
        throw new Error('file_identity_mismatch')
      }
      const maximum = host.maxMediaBytes ?? 100 * 1024 * 1024
      if ((file.size ?? 0) > maximum) {
        throw new MediaDownloadError('media_too_large')
      }
      const url = file.url_private_download ?? file.url_private
      if (!url) {
        throw new Error('missing_file_url')
      }

      const downloaded = await downloadMedia(url, {
        maxBytes: maximum,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        trustedOrigins: [
          'https://files.slack.com',
          new URL(API_BASE_URL).origin
        ],
        allowInsecureLocalhost: false,
        headers: { authorization: `Bearer ${token}` }
      })

      const mimeType = file.mimetype ?? downloaded.mimeType
      return {
        kind: mediaKind(mimeType),
        mimeType,
        fileName: file.name ?? file.id,
        data: downloaded.data
      }
    })
  )
}

async function upload(
  client: WebClient,
  media: StoredMedia,
  chatId?: string,
  threadId?: string,
  initialComment?: string
): Promise<string | undefined> {
  const file = {
    file: Buffer.from(media.data),
    filename: media.reference.fileName,
    title: media.reference.fileName,
    ...(chatId ? { channel_id: chatId } : {}),
    ...(initialComment ? { initial_comment: initialComment } : {})
  }

  const result =
    chatId && threadId
      ? await client.filesUploadV2({
          ...file,
          channel_id: chatId,
          thread_ts: threadId
        })
      : await client.filesUploadV2(file)

  return result.files
    .flatMap((completion) => completion.files ?? [])
    .find((uploaded) => uploaded.id)?.id
}

export async function sendMedia(
  input: SendInput,
  client: WebClient
): Promise<SendResult> {
  if (!input.media) {
    return { status: 'rejected', errorCode: 'missing_media' }
  }

  const threadId =
    input.target.threadId ?? (input.reply ? input.target.replyToId : undefined)

  try {
    const id = await upload(
      client,
      input.media,
      input.target.chatId,
      threadId,
      input.chunk.text ? slackMarkdown(input.chunk.text).text : undefined
    )

    return id
      ? { status: 'sent', receipt: { platformMessageId: id } }
      : { status: 'unknown', errorCode: 'invalid_upload_completion' }
  } catch (error) {
    return sdkFailure(error)
  }
}

export async function richBlocks(
  input: SendInput,
  client: WebClient
): Promise<{ text: string; blocks: KnownBlock[] } | SendResult> {
  const blocks: KnownBlock[] = []
  const text: string[] = []
  let imageIndex = 0
  try {
    for (const part of input.chunk.richText ?? []) {
      if (part.type === 'text') {
        const formatted = slackMarkdown(part.text)
        blocks.push(...formatted.blocks)
        text.push(formatted.text)
        continue
      }
      const media = input.richMedia?.[imageIndex++]
      if (!media) {
        return { status: 'rejected', errorCode: 'missing_media' }
      }
      const id = await upload(client, media)
      if (!id) {
        return { status: 'retryable', errorCode: 'invalid_upload_completion' }
      }
      blocks.push({
        type: 'image',
        slack_file: { id },
        alt_text: part.label || part.media.fileName
      })
      text.push(part.label)
    }
    return { text: text.join('\n'), blocks }
  } catch (error) {
    return sdkFailure(error, true)
  }
}

export { slackMarkdown, splitSlackMarkdown } from './markdown.js'
export { richError, richCapabilities } from './rich.js'
