import { createHash } from 'node:crypto'
import type {
  AgentId,
  AgentAttachment,
  ConversationRecord,
  Storage,
  AgentMediaHost,
  MediaUpload,
  MediaReference,
  StoredMedia
} from '@relanox/sdk'
import { authorizedConversation } from './conversations.js'
import { CoreError } from '../errors.js'
import { textId } from '../validation.js'
import {
  mediaId,
  storeUpload,
  verifiedMedia,
  validateMediaCount,
  validateMediaTotal
} from '../media.js'
import type { WorkerConfig } from '../worker/options.js'

export function createAgentMedia(
  storage: Storage,
  agent: AgentId,
  scope: readonly string[],
  worker: WorkerConfig,
  configured: ReadonlyMap<string, ConversationRecord>
): AgentMediaHost {
  return {
    maxBytes: worker.maxMediaBytes,
    maxTotalBytes: worker.maxTotalMediaBytes,
    maxAttachments: worker.maxAttachments,
    async authorize(input) {
      textId.parse(input.channelId)
      return authorizedConversation(
        await storage.getConversation(input.channelId),
        agent,
        scope,
        configured
      )
    },
    async upload(input): Promise<MediaReference | undefined> {
      textId.parse(input.channelId)
      mediaId.parse(input.mediaId)
      if (
        !authorizedConversation(
          await storage.getConversation(input.channelId),
          agent,
          scope,
          configured
        )
      ) {
        return undefined
      }
      if (!storage.media) {
        throw new CoreError('media_storage_missing')
      }

      const result = await storage.media.put({
        channelId: input.channelId,
        agent,
        endpointIds: scope,
        media: storeUpload(input.upload, input.mediaId, worker.maxMediaBytes),
        maxBytes: worker.maxMediaBytes,
        maxCount: worker.maxAttachments * 2,
        maxTotalBytes: worker.maxTotalMediaBytes * 2
      })

      if (result.status === 'unauthorized') {
        return undefined
      }
      if (result.status !== 'stored') {
        throw new CoreError(
          result.status === 'conflict' ? 'media_conflict' : result.status
        )
      }
      return result.reference
    },
    async read(input): Promise<StoredMedia | undefined> {
      textId.parse(input.channelId)
      mediaId.parse(input.mediaId)
      const request = await storage.getConversation(input.channelId)
      if (!authorizedConversation(request, agent, scope, configured)) {
        return undefined
      }
      const media = await storage.media?.get(input.channelId, input.mediaId)
      return media
        ? verifiedMedia(media, media.reference, worker.maxMediaBytes)
        : undefined
    }
  }
}

/** Channel and send-intent ownership makes generated assets replayable for that send. */
function outgoingMedia(
  channelId: string,
  intent: string,
  upload: MediaUpload,
  maximum: number
): StoredMedia {
  const stored = storeUpload(upload, crypto.randomUUID(), maximum)
  const { id: _id, ...metadata } = stored.reference

  const digest = createHash('sha256')
    .update(JSON.stringify([channelId, intent, metadata]))
    .digest('hex')

  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  return { ...stored, reference: { ...stored.reference, id } }
}

type PreparedMedia = {
  readonly references: readonly MediaReference[]
  readonly cached: readonly StoredMedia[]
}

function generatedGraph(
  channelId: string,
  intent: string,
  attachment: Exclude<AgentAttachment, string>,
  maximum: number
): { primary: StoredMedia; assets: readonly StoredMedia[] } {
  if (!('media' in attachment)) {
    const primary = outgoingMedia(channelId, intent, attachment, maximum)
    return { primary, assets: [primary] }
  }
  const preview = outgoingMedia(channelId, intent, attachment.preview, maximum)
  if (
    preview.reference.kind !== 'image' ||
    preview.reference.previewMediaId !== undefined
  ) {
    throw new CoreError('invalid_media_preview')
  }

  const primary = outgoingMedia(
    channelId,
    intent,
    { ...attachment.media, previewMediaId: preview.reference.id },
    maximum
  )

  return { primary, assets: [preview, primary] }
}

/** Keyed replay needs immutable metadata even after content retention. */
export async function prepareMessageMedia(
  storage: Storage,
  channelId: string,
  intent: string,
  attachments: readonly AgentAttachment[] | undefined,
  worker: WorkerConfig,
  recovery: boolean
): Promise<PreparedMedia> {
  validateMediaCount(attachments?.length ?? 0, worker.maxAttachments)
  const references: MediaReference[] = []
  const cached: StoredMedia[] = []
  for (const attachment of attachments ?? []) {
    if (typeof attachment !== 'string') {
      const graph = generatedGraph(
        channelId,
        intent,
        attachment,
        worker.maxMediaBytes
      )

      references.push(graph.primary.reference)
      cached.push(...graph.assets)
      continue
    }
    const id = mediaId.parse(attachment)
    if (recovery) {
      const reference = await storage.media?.getReference(channelId, id)
      if (!reference) {
        throw new CoreError('media_not_found')
      }
      references.push(reference)
    } else {
      const stored = await storage.media?.get(channelId, id)
      if (!stored) {
        throw new CoreError('media_not_found')
      }
      cached.push(verifiedMedia(stored, stored.reference, worker.maxMediaBytes))
      references.push(stored.reference)
    }
  }
  if (
    new Set(references.map((reference) => reference.id)).size !==
    references.length
  ) {
    throw new CoreError('duplicate_attachment')
  }
  return { references, cached }
}

export async function messageMedia(
  storage: Storage,
  channelId: string,
  prepared: PreparedMedia,
  worker: WorkerConfig
): Promise<{
  attachments: readonly StoredMedia[]
  stored: readonly StoredMedia[]
}> {
  const cache = new Map(
    prepared.cached.map((asset) => [asset.reference.id, asset])
  )

  const attachments: StoredMedia[] = []
  const assets = new Map<string, StoredMedia>()
  for (const ref of prepared.references) {
    const cached = cache.get(ref.id)
    const stored = cached ?? (await storage.media?.get(channelId, ref.id))
    if (!stored) {
      throw new CoreError('media_not_found')
    }
    const primary = cached ?? verifiedMedia(stored, ref, worker.maxMediaBytes)
    assets.set(ref.id, primary)
    attachments.push(primary)
    if (ref.previewMediaId === undefined) {
      continue
    }

    const preview =
      cache.get(ref.previewMediaId) ??
      (await readPreview(storage, channelId, primary, worker.maxMediaBytes))

    if (
      preview?.reference.kind !== 'image' ||
      preview.reference.previewMediaId !== undefined
    ) {
      throw new CoreError('invalid_media_preview')
    }
    assets.set(preview.reference.id, preview)
  }
  const stored = [...assets.values()]
  validateMediaTotal(stored, worker.maxTotalMediaBytes)
  return { attachments, stored }
}

export async function readPreview(
  storage: Storage,
  channelId: string,
  media: StoredMedia,
  maximum: number
): Promise<StoredMedia | undefined> {
  const id = media.reference.previewMediaId
  if (id === undefined) {
    return undefined
  }
  mediaId.parse(id)
  const preview = await storage.media?.get(channelId, id)
  if (
    preview?.reference.kind !== 'image' ||
    preview.reference.previewMediaId !== undefined
  ) {
    throw new CoreError('invalid_media_preview')
  }
  return verifiedMedia(preview, preview.reference, maximum)
}
