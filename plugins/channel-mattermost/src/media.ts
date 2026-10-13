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
import { z } from 'zod'
import type { MattermostConfig } from './config.js'
import { diagnose, httpFailure, readJson } from './protocol.js'

const infoSchema = z.object({
  id: z.string().min(1).max(1024),
  name: z.string().min(1).max(255),
  mime_type: z.string().max(128),
  size: z.number().int().nonnegative()
})

async function collectFiles(
  ids: readonly string[],
  host: ChannelHost,
  config: MattermostConfig,
  base: string,
  authorization: string,
  signal: AbortSignal
): Promise<MediaUpload[]> {
  const attachments: MediaUpload[] = []
  const bound = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
  for (const id of ids) {
    const url = `${base}/api/v4/files/${encodeURIComponent(id)}`

    const response = await fetch(`${url}/info`, {
      headers: { Authorization: authorization },
      redirect: 'error',
      signal: bound
    })

    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('media_metadata_failed')
    }
    const info = infoSchema.parse(await readJson(response))
    if (info.id !== id) {
      throw new Error('invalid_media_metadata')
    }
    if (info.size > (host.maxMediaBytes ?? 16_777_216)) {
      throw new MediaDownloadError('media_too_large')
    }

    const downloaded = await downloadMedia(url, {
      maxBytes: host.maxMediaBytes ?? 16_777_216,
      signal: bound,
      headers: { Authorization: authorization },
      trustedOrigins: [new URL(base).origin],
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
  ids: readonly string[],
  host: ChannelHost,
  config: MattermostConfig,
  base: string,
  authorization: string,
  signal: AbortSignal
): Promise<MediaUpload[] | undefined> {
  try {
    return await collectFiles(ids, host, config, base, authorization, signal)
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
  base: string,
  authorization: string,
  signal: AbortSignal
): Promise<{ fileId: string } | SendResult> {
  if (!input.media) {
    throw new Error('media_missing')
  }
  const form = new FormData()
  form.set('channel_id', input.target.chatId)
  form.set('files', mediaBlob(input.media), input.media.reference.fileName)
  try {
    const response = await fetch(`${base}/api/v4/files`, {
      method: 'POST',
      body: form,
      headers: { Authorization: authorization },
      redirect: 'error',
      signal
    })

    if (!response.ok) {
      await response.body?.cancel()
      const result = httpFailure(response)
      return result.status === 'unknown'
        ? { status: 'retryable', errorCode: 'media_upload_failed' }
        : result
    }

    const uploaded = z
      .object({
        file_infos: z
          .array(z.object({ id: z.string().min(1).max(1024) }))
          .length(1)
      })
      .parse(await readJson(response))

    const file = uploaded.file_infos[0]
    if (!file) {
      throw new Error('media_upload_failed')
    }
    return { fileId: file.id }
  } catch {
    return { status: 'retryable', errorCode: 'media_upload_failed' }
  }
}
