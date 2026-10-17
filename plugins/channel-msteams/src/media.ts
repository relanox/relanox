import {
  downloadMedia,
  mediaKind,
  MediaDownloadError
} from '@relanox/channel-media'
import type {
  ChannelHost,
  Json,
  MediaUpload,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { z } from 'zod'
import type { TeamsConfig } from './config.js'
import type { TeamsClient } from './native.js'
import type { Activity, Attachment } from '@microsoft/teams.api'
import { request } from './io.js'

const consentSchema = z.object({
  phase: z.enum(['posting', 'waiting', 'accept', 'decline', 'uploaded']),
  offset: z.number().int().nonnegative().optional(),
  conversationId: z.string(),
  userId: z.string(),
  botId: z.string(),
  uploadInfo: z
    .object({
      uploadUrl: z.url(),
      contentUrl: z.url(),
      uniqueId: z.string(),
      fileType: z.string()
    })
    .optional()
})

export const invokeSchema = z.object({
  action: z.enum(['accept', 'decline']),
  context: z.object({ consentId: z.string().min(1) }),
  uploadInfo: z
    .object({
      uploadUrl: z.url(),
      contentUrl: z.url(),
      uniqueId: z.string(),
      fileType: z.string()
    })
    .optional()
})

export async function acceptConsent(
  host: ChannelHost,
  value: unknown,
  identity: { conversationId: string; userId: string; botId: string }
): Promise<void> {
  const invoke = invokeSchema.parse(value)
  const key = `consent:${invoke.context.consentId}`
  const entry = await host.state.get(key)
  if (!entry) {
    throw new Error('unknown_file_consent')
  }
  const state = consentSchema.parse(entry.value)
  if (
    state.conversationId !== identity.conversationId ||
    state.userId !== identity.userId ||
    state.botId !== identity.botId
  ) {
    throw new Error('invalid_file_consent_identity')
  }
  if (state.phase !== 'waiting' && state.phase !== 'posting') {
    return
  }
  if (invoke.action === 'accept' && !invoke.uploadInfo) {
    throw new Error('missing_file_upload_info')
  }

  const result = await host.state.compareAndSet({
    key,
    expectedVersion: entry.version,
    value: {
      conversationId: state.conversationId,
      userId: state.userId,
      botId: state.botId,
      phase: invoke.action,
      ...(invoke.uploadInfo ? { uploadInfo: invoke.uploadInfo } : {})
    }
  })

  if (result.status !== 'updated') {
    throw new Error('file_consent_contention')
  }
}

export type PreparedAttachment = {
  readonly attachment?: Attachment
  readonly outcome?: SendResult
  readonly consentKey?: string
}

export async function prepareAttachment(
  host: ChannelHost,
  config: TeamsConfig,
  input: SendInput,
  identity: { conversationId: string; userId: string; botId: string },
  personal: boolean
): Promise<PreparedAttachment> {
  if (!input.chunk.media) {
    return {}
  }
  if (!input.media) {
    return { outcome: { status: 'rejected', errorCode: 'missing_media' } }
  }
  const { kind, fileName, size } = input.media.reference
  if (usesImageAttachment(kind, input.media.data.byteLength, personal)) {
    return imageAttachment(input, host)
  }
  if (!personal) {
    return {
      outcome: {
        status: 'rejected',
        errorCode: 'file_consent_requires_personal_chat'
      }
    }
  }
  const key = `consent:${input.chunk.idempotencyKey}`
  const entry = await host.state.get(key)
  if (!entry) {
    const created = await host.state.compareAndSet({
      key,
      expectedVersion: null,
      value: { phase: 'posting', ...identity }
    })

    if (created.status !== 'updated') {
      return {
        outcome: {
          status: 'retryable',
          errorCode: 'file_consent_contention',
          retryAfterMs: 1000
        }
      }
    }
    const context = { consentId: input.chunk.idempotencyKey }
    return {
      consentKey: key,
      attachment: {
        contentType: 'application/vnd.microsoft.teams.card.file.consent',
        name: fileName,
        content: {
          description: input.chunk.text || fileName,
          sizeInBytes: size,
          acceptContext: context,
          declineContext: context
        }
      }
    }
  }
  const state = consentSchema.parse(entry.value)
  if (!matchesIdentity(state, identity)) {
    return {
      outcome: {
        status: 'rejected',
        errorCode: 'invalid_file_consent_identity'
      }
    }
  }
  if (state.phase === 'posting') {
    return {
      outcome: { status: 'unknown', errorCode: 'file_consent_send_uncertain' }
    }
  }
  if (state.phase === 'waiting') {
    return {
      outcome: {
        status: 'pending',
        retryAfterMs: 30_000
      }
    }
  }
  if (state.phase === 'decline') {
    return {
      outcome: { status: 'rejected', errorCode: 'file_consent_declined' }
    }
  }
  const info = state.uploadInfo
  if (!info) {
    return {
      outcome: { status: 'rejected', errorCode: 'missing_file_upload_info' }
    }
  }
  const url = new URL(info.uploadUrl)
  if (
    !config.trustedUploadOrigins.includes(url.origin) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return {
      outcome: { status: 'rejected', errorCode: 'untrusted_file_upload_origin' }
    }
  }
  if (state.phase !== 'uploaded') {
    const outcome = await uploadFile(host, key, input, url)
    if (outcome) {
      return { outcome }
    }
  }
  return {
    attachment: {
      contentType: 'application/vnd.microsoft.teams.card.file.info',
      contentUrl: info.contentUrl,
      name: fileName,
      content: { uniqueId: info.uniqueId, fileType: info.fileType }
    }
  }
}

// OneDrive upload sessions require sequential fragments below 60 MiB and
// Multiples of 320 KiB (except the final fragment). Ten MiB satisfies both.
// https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
async function uploadFile(
  host: ChannelHost,
  key: string,
  input: SendInput,
  url: URL
): Promise<SendResult | undefined> {
  const media = input.media
  if (!media) {
    throw new Error('missing_media')
  }
  const size = media.data.byteLength
  const fragmentBytes = 10 * 1024 * 1024
  let entry = await host.state.get(key)
  if (!entry) {
    throw new Error('missing_consent_state')
  }
  let state = consentSchema.parse(entry.value)
  let offset = state.offset ?? 0
  while (offset < size) {
    const end = Math.min(size, offset + fragmentBytes)

    const response = await request(
      url,
      {
        method: 'PUT',
        headers: {
          'content-type': media.reference.mimeType,
          'content-range': `bytes ${offset}-${end - 1}/${size}`
        },
        body: new Blob([media.data.slice(offset, end)])
      },
      input.signal
    )

    await response.body?.cancel()
    if (!response.ok) {
      return {
        status: uploadStatus(response.status),
        errorCode: 'file_upload_failed'
      }
    }
    const complete = end === size && response.status !== 202
    if (end === size && !complete) {
      return { status: 'retryable', errorCode: 'file_upload_incomplete' }
    }

    const result = await host.state.compareAndSet({
      key,
      expectedVersion: entry.version,
      value: {
        conversationId: state.conversationId,
        userId: state.userId,
        botId: state.botId,
        ...(state.uploadInfo ? { uploadInfo: state.uploadInfo } : {}),
        offset: end,
        phase: complete ? 'uploaded' : 'accept'
      }
    })

    if (result.status !== 'updated') {
      throw new Error('file_consent_contention')
    }
    offset = end
    entry = await host.state.get(key)
    if (!entry) {
      throw new Error('missing_consent_state')
    }
    state = consentSchema.parse(entry.value)
  }
  return undefined
}

function usesImageAttachment(
  kind: string,
  byteLength: number,
  personal: boolean
): boolean {
  return kind === 'image' && (byteLength <= 15_000 || !personal)
}

function uploadStatus(status: number): 'retryable' | 'rejected' {
  return status === 429 || status >= 500 ? 'retryable' : 'rejected'
}

export async function consentPostRefused(
  host: ChannelHost,
  key: string
): Promise<void> {
  const entry = await host.state.get(key)
  if (entry && consentSchema.parse(entry.value).phase === 'posting') {
    const result = await host.state.delete(key, entry.version)
    if (result.status !== 'updated') {
      throw new Error('file_consent_contention')
    }
  }
}

export async function consentPosted(
  host: ChannelHost,
  key: string
): Promise<void> {
  const entry = await host.state.get(key)
  if (!entry) {
    throw new Error('missing_consent_state')
  }
  const state = consentSchema.parse(entry.value)
  if (state.phase === 'posting') {
    await host.state.compareAndSet({
      key,
      expectedVersion: entry.version,
      value: {
        conversationId: state.conversationId,
        userId: state.userId,
        botId: state.botId,
        phase: 'waiting'
      }
    })
  }
}

export async function downloadAttachments(
  activity: Extract<Activity, { type: 'message' }>,
  host: ChannelHost,
  config: TeamsConfig,
  client: TeamsClient
): Promise<MediaUpload[]> {
  const attachments = []
  const signal = AbortSignal.timeout(120_000)
  for (const attachment of activity.attachments ?? []) {
    const file =
      attachment.contentType ===
      'application/vnd.microsoft.teams.file.download.info'

    if (
      ['text/html', 'text/plain'].includes(attachment.contentType) &&
      !attachment.contentUrl
    ) {
      continue
    }

    const url = file
      ? z.object({ downloadUrl: z.url() }).parse(attachment.content).downloadUrl
      : attachment.contentUrl

    if (!url) {
      throw new Error('missing_media_url')
    }
    const origin = new URL(url).origin
    const trusted = config.trustedServiceOrigins.includes(origin)

    const token = !file && trusted ? await client.accessToken() : undefined

    if (token !== undefined && typeof token !== 'string') {
      throw new Error('media_oauth_unavailable')
    }

    const downloaded = await downloadMedia(url, {
      maxBytes: host.maxMediaBytes ?? 100 * 1024 * 1024,
      signal,
      trustedOrigins: [...config.trustedServiceOrigins, ...config.mediaOrigins],
      ...(typeof token === 'string'
        ? { headers: { authorization: `Bearer ${token}` } }
        : {})
    }).catch((error: unknown) => {
      if (
        typeof token === 'string' &&
        error instanceof MediaDownloadError &&
        error.status === 401
      ) {
        client.invalidate()
      }
      throw error
    })

    const mimeType = file ? downloaded.mimeType : attachment.contentType
    attachments.push({
      data: downloaded.data,
      mimeType,
      kind: mediaKind(mimeType),
      fileName: attachment.name ?? 'attachment.bin'
    })
  }
  return attachments
}

function matchesIdentity(
  state: { conversationId: string; userId: string; botId: string },
  identity: { conversationId: string; userId: string; botId: string }
): boolean {
  return (
    state.conversationId === identity.conversationId &&
    state.userId === identity.userId &&
    state.botId === identity.botId
  )
}

async function imageAttachment(
  input: SendInput,
  host: ChannelHost
): Promise<PreparedAttachment> {
  if (!input.media) {
    return { outcome: { status: 'rejected', errorCode: 'missing_media' } }
  }
  const { mimeType, fileName, id } = input.media.reference
  let contentUrl
  // Keep the base64 envelope below the native Teams message payload budget.
  if (input.media.data.byteLength <= 15_000) {
    contentUrl = `data:${mimeType};base64,${Buffer.from(input.media.data).toString('base64')}`
  } else {
    if (!host.media) {
      return {
        outcome: {
          status: 'rejected',
          errorCode: 'media_publication_unavailable'
        }
      }
    }
    contentUrl = await host.media.publish({
      channelId: input.channelId,
      mediaId: id
    })
  }
  return { attachment: { contentType: mimeType, name: fileName, contentUrl } }
}

export async function richAttachment(
  input: SendInput,
  host: ChannelHost
): Promise<Attachment | undefined> {
  if (!input.chunk.richText) {
    return undefined
  }
  if (!host.media || !host.publicUrl) {
    throw new Error('media_publication_unavailable')
  }
  const body: Json[] = []
  for (const part of input.chunk.richText) {
    if (part.type === 'text') {
      body.push({ type: 'TextBlock', text: part.text, wrap: true })
    } else {
      const url = new URL(
        await host.media.publish({
          channelId: input.channelId,
          mediaId: part.media.id
        })
      )

      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error('invalid_publication_url')
      }
      body.push({
        type: 'Image',
        url: url.href,
        altText: part.label || part.media.fileName
      })
    }
  }

  const attachment = {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.2',
      body
    }
  }

  if (Buffer.byteLength(JSON.stringify(attachment), 'utf8') > 24_000) {
    throw new Error('rich_text_limit_exceeded')
  }
  return attachment
}

export { richError, richCapabilities } from './rich.js'

export function richPreparationFailure(error: unknown): SendResult {
  if (
    error instanceof Error &&
    [
      'media_publication_unavailable',
      'invalid_publication_url',
      'rich_text_limit_exceeded'
    ].includes(error.message)
  ) {
    return { status: 'rejected', errorCode: error.message }
  }
  return { status: 'retryable', errorCode: 'media_preparation_unavailable' }
}
