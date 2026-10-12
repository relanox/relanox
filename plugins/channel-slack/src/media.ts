import { slackMarkdown } from './markdown.js'
import { REQUEST_TIMEOUT_MS, API_BASE_URL } from './config.js'
import { downloadMedia, mediaBlob, mediaKind } from '@relanox/channel-media'
import type {
  Json,
  ChannelHost,
  MediaUpload,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { z } from 'zod'
import { fileSchema } from './schemas.js'
import type { messageSchema } from './schemas.js'
import { failure, jsonResponse, postJson } from './transport.js'
import { apiError } from './client.js'

export { sendOutcome, discoverIdentity } from './client.js'

async function fileMetadata(
  file: z.infer<typeof fileSchema>,
  token: string
): Promise<{
  [x: string]: unknown
  id: string
  name?: string | undefined
  mimetype?: string | undefined
  size?: number | undefined
  url_private?: string | undefined
  url_private_download?: string | undefined
}> {
  if (file.url_private_download ?? file.url_private) {
    return file
  }

  const response = await fetch(
    `${API_BASE_URL.replace(/\/$/u, '')}/files.info?file=${encodeURIComponent(file.id)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error'
    }
  )

  const metadata = z
    .looseObject({ ok: z.literal(true), file: fileSchema })
    .parse(await jsonResponse(response))

  if (!response.ok || metadata.file.id !== file.id) {
    throw new Error('file_metadata_unavailable')
  }
  return metadata.file
}

export async function receiveMedia(
  files: z.infer<typeof messageSchema>['files'],
  host: ChannelHost,
  token: string
): Promise<MediaUpload[]> {
  return Promise.all(
    files.map(async (eventFile) => {
      const file = await fileMetadata(eventFile, token)
      if ((file.size ?? 0) > (host.maxMediaBytes ?? 25 * 1024 * 1024)) {
        throw new Error('media_too_large')
      }
      const url = file.url_private_download ?? file.url_private
      if (!url) {
        throw new Error('missing_file_url')
      }

      const downloaded = await downloadMedia(url, {
        maxBytes: host.maxMediaBytes ?? 25 * 1024 * 1024,
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

const uploadSchema = z.looseObject({
  ok: z.boolean(),
  upload_url: z.url().optional(),
  file_id: z.string().min(1).optional(),
  error: z.string().optional()
})

const completeSchema = z.looseObject({
  ok: z.boolean(),
  files: z.array(z.looseObject({ id: z.string() })).optional(),
  error: z.string().optional()
})

function uploadFailure(result: SendResult): SendResult {
  return result.status === 'unknown'
    ? { ...result, status: 'retryable' }
    : result
}

async function prepareUpload(
  input: SendInput,
  token: string
): Promise<{ file_id: string } | SendResult> {
  if (!input.media) {
    return { status: 'rejected', errorCode: 'missing_media' }
  }
  const base = API_BASE_URL.replace(/\/$/u, '')
  const headers = { authorization: `Bearer ${token}` }
  try {
    const requested = await fetch(`${base}/files.getUploadURLExternal`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        filename: input.media.reference.fileName,
        length: String(input.media.data.byteLength)
      }),
      signal: AbortSignal.any([
        input.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      ]),
      redirect: 'error'
    })

    if (!requested.ok) {
      return uploadFailure(failure(requested))
    }
    const upload = uploadSchema.parse(await jsonResponse(requested))
    if (!upload.ok) {
      return uploadFailure(apiError(upload.error))
    }
    if (!upload.upload_url || !upload.file_id) {
      return { status: 'retryable', errorCode: 'invalid_upload_response' }
    }
    const url = new URL(upload.upload_url)
    if (
      url.username ||
      url.password ||
      url.hash ||
      !['https://files.slack.com', new URL(base).origin].includes(url.origin)
    ) {
      return { status: 'rejected', errorCode: 'invalid_upload_url' }
    }

    const uploaded = await fetch(url, {
      method: 'POST',
      body: mediaBlob(input.media),
      signal: AbortSignal.any([
        input.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      ]),
      redirect: 'error'
    })

    if (!uploaded.ok) {
      return uploadFailure(failure(uploaded))
    }
    return { file_id: upload.file_id }
  } catch {
    return { status: 'retryable', errorCode: 'slack_upload_transport_error' }
  }
}

export { slackMarkdown, splitSlackMarkdown } from './markdown.js'

export async function sendMedia(
  input: SendInput,
  host: ChannelHost,
  token: string
): Promise<SendResult> {
  if (
    !input.media ||
    input.media.data.byteLength > (host.maxMediaBytes ?? 25 * 1024 * 1024)
  ) {
    return { status: 'rejected', errorCode: 'media_limit_exceeded' }
  }
  const base = API_BASE_URL.replace(/\/$/u, '')
  const headers = { authorization: `Bearer ${token}` }
  const prepared = await prepareUpload(input, token)
  if ('status' in prepared) {
    return prepared
  }
  const upload = prepared

  const response = await postJson(
    `${base}/files.completeUploadExternal`,
    headers,
    {
      files: [{ id: upload.file_id, title: input.media.reference.fileName }],
      channel_id: input.target.chatId,
      ...(input.target.threadId ? { thread_ts: input.target.threadId } : {}),
      ...(input.chunk.text
        ? {
            initial_comment: input.chunk.text
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;')
          }
        : {})
    },
    input.signal,
    REQUEST_TIMEOUT_MS
  )

  if (!response.ok) {
    return failure(response)
  }
  const completed = completeSchema.parse(await jsonResponse(response))
  if (!completed.ok) {
    return apiError(completed.error)
  }
  return completed.files?.some((file) => file.id === upload.file_id)
    ? { status: 'sent', receipt: { platformMessageId: upload.file_id } }
    : { status: 'unknown', errorCode: 'invalid_upload_completion' }
}

export async function richBlocks(
  input: SendInput,
  token: string
): Promise<{ text: string; blocks: Json[] } | SendResult> {
  const blocks: Json[] = []
  const text: string[] = []
  let imageIndex = 0
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
    const prepared = await prepareUpload({ ...input, media }, token)
    if ('status' in prepared) {
      return prepared
    }

    const response = await postJson(
      `${API_BASE_URL}/files.completeUploadExternal`,
      { authorization: `Bearer ${token}` },
      { files: [{ id: prepared.file_id, title: part.media.fileName }] },
      input.signal,
      REQUEST_TIMEOUT_MS
    )

    if (!response.ok) {
      return uploadFailure(failure(response))
    }
    const completed = completeSchema.parse(await jsonResponse(response))
    if (!completed.ok) {
      return uploadFailure(apiError(completed.error))
    }
    if (!completed.files?.some((file) => file.id === prepared.file_id)) {
      return { status: 'retryable', errorCode: 'invalid_upload_completion' }
    }
    blocks.push({
      type: 'image',
      slack_file: { id: prepared.file_id },
      alt_text: part.label || part.media.fileName
    })
    text.push(part.label)
  }
  return { text: text.join('\n'), blocks }
}

export { richError, richCapabilities } from './rich.js'
