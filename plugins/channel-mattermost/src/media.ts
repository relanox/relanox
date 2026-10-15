import { requestTimeoutMs } from './constants.js'
import {
  downloadMedia,
  MediaDownloadError,
  mediaBlob,
  mediaKind
} from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaUpload,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { platformIdSchema } from './config.js'
import type { MattermostConfig } from './config.js'
import type { MattermostClient } from './client.js'
import type { Post } from '@mattermost/types/posts'
import { diagnose, sendFailure } from './protocol.js'

async function collectFiles(
  post: Pick<Post, 'id' | 'file_ids'>,
  host: ChannelHost,
  config: MattermostConfig,
  client: MattermostClient,
  signal: AbortSignal
): Promise<MediaUpload[]> {
  const attachments: MediaUpload[] = []
  if (!post.file_ids?.length) {
    return attachments
  }
  const metadata = await client.getFileInfosForPost(post.id)
  const bound = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
  for (const id of post.file_ids) {
    const url = client.getFileUrl(encodeURIComponent(id), 0)
    const info = metadata.find((file) => file.id === id)
    if (!info) {
      throw new Error('invalid_media_metadata')
    }
    if (info.size > (host.maxMediaBytes ?? 100 * 1024 * 1024)) {
      throw new MediaDownloadError('media_too_large')
    }

    const downloaded = await downloadMedia(url, {
      maxBytes: host.maxMediaBytes ?? 100 * 1024 * 1024,
      signal: bound,
      headers: { Authorization: `Bearer ${client.getToken()}` },
      trustedOrigins: [new URL(client.getUrl()).origin],
      allowInsecureLocalhost: config.allowInsecureLocalhost
    })

    // Mattermost NewInfo preserves MIME parameters and leaves unknown extensions empty.
    const declaredMime =
      info.mime_type.split(';')[0]?.trim().toLowerCase() ?? ''

    const mimeType =
      declaredMime.length > 0 ? declaredMime : 'application/octet-stream'

    attachments.push({
      kind: mediaKind(mimeType),
      mimeType,
      fileName: info.name,
      data: downloaded.data
    })
  }
  return attachments
}

export async function receiveFiles(
  post: Pick<Post, 'id' | 'file_ids'>,
  host: ChannelHost,
  config: MattermostConfig,
  client: MattermostClient,
  signal: AbortSignal
): Promise<MediaUpload[] | undefined> {
  try {
    return await collectFiles(post, host, config, client, signal)
  } catch (error) {
    if (
      error instanceof MediaDownloadError &&
      error.code === 'media_too_large'
    ) {
      diagnose(host, 'media_limit_unsupported')
      return undefined
    }
    throw error
  }
}

export async function uploadFile(
  input: SendInput,
  client: MattermostClient
): Promise<{ fileId: string } | SendResult> {
  if (!input.media) {
    throw new Error('media_missing')
  }
  const form = new FormData()
  form.set('channel_id', input.target.chatId)
  form.set('files', mediaBlob(input.media), input.media.reference.fileName)
  try {
    const uploaded = await client.uploadFile(form)
    if (uploaded.file_infos.length !== 1) {
      throw new Error('media_upload_failed')
    }
    return { fileId: platformIdSchema.parse(uploaded.file_infos[0]?.id) }
  } catch (error) {
    const failure = sendFailure(error)
    // A failed blob upload cannot have delivered a channel post.
    return failure.status === 'unknown'
      ? { status: 'retryable', errorCode: 'media_upload_failed' }
      : failure
  }
}
