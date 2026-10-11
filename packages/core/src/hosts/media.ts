import { createHash } from 'node:crypto'
import type {
  AgentId,
  AgentAttachment,
  InboundRecord,
  Storage,
  AgentMediaHost,
  MediaUpload,
  StoredMedia
} from '@relanox/sdk'
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

export function authorizedRequest(
  request: InboundRecord | undefined,
  agent: AgentId,
  scope: readonly string[]
): request is InboundRecord {
  return (
    request?.snapshot.endpoint.agent === agent &&
    scope.includes(request.snapshot.endpoint.id) &&
    request.redactedAt === undefined
  )
}

export function createAgentMedia(
  storage: Storage,
  agent: AgentId,
  scope: readonly string[],
  worker: WorkerConfig
): AgentMediaHost {
  return {
    maxBytes: worker.maxMediaBytes,
    maxTotalBytes: worker.maxTotalMediaBytes,
    maxAttachments: worker.maxAttachments,
    async read(input): Promise<StoredMedia | undefined> {
      textId.parse(input.requestId)
      mediaId.parse(input.mediaId)
      const request = await storage.getInbound(input.requestId)
      if (!authorizedRequest(request, agent, scope)) {
        return undefined
      }
      const media = await storage.media?.get(input.requestId, input.mediaId)
      return media
        ? verifiedMedia(media, media.reference, worker.maxMediaBytes)
        : undefined
    }
  }
}

/** Stable request-owned asset IDs make a repeated send with identical bytes replayable. */
function outgoingMedia(
  requestId: string,
  upload: MediaUpload,
  maximum: number
): StoredMedia {
  const stored = storeUpload(upload, crypto.randomUUID(), maximum)
  const { id: _id, ...metadata } = stored.reference

  const digest = createHash('sha256')
    .update(JSON.stringify([requestId, metadata]))
    .digest('hex')

  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  return { ...stored, reference: { ...stored.reference, id } }
}

export async function messageMedia(
  storage: Storage,
  requestId: string,
  attachments: readonly AgentAttachment[] | undefined,
  worker: WorkerConfig
): Promise<{
  attachments: readonly StoredMedia[]
  stored: readonly StoredMedia[]
}> {
  validateMediaCount(attachments?.length ?? 0, worker.maxAttachments)
  const media: StoredMedia[] = []
  const assets: StoredMedia[] = []
  for (const attachment of attachments ?? []) {
    if (typeof attachment !== 'string' && 'media' in attachment) {
      const preview = outgoingMedia(
        requestId,
        attachment.preview,
        worker.maxMediaBytes
      )

      if (
        preview.reference.kind !== 'image' ||
        preview.reference.previewMediaId !== undefined
      ) {
        throw new CoreError('invalid_media_preview')
      }

      const main = outgoingMedia(
        requestId,
        {
          ...attachment.media,
          previewMediaId: preview.reference.id
        },
        worker.maxMediaBytes
      )

      assets.push(preview, main)
      media.push(main)
      continue
    }

    const stored =
      typeof attachment === 'string'
        ? await storage.media?.get(requestId, mediaId.parse(attachment))
        : outgoingMedia(requestId, attachment, worker.maxMediaBytes)

    if (!stored) {
      throw new CoreError('media_not_found')
    }

    const checked =
      typeof attachment === 'string'
        ? verifiedMedia(stored, stored.reference, worker.maxMediaBytes)
        : stored

    const preview = await readPreview(
      storage,
      requestId,
      checked,
      worker.maxMediaBytes
    )

    if (preview) {
      assets.push(preview)
    }
    assets.push(checked)
    media.push(checked)
  }
  if (new Set(media.map((item) => item.reference.id)).size !== media.length) {
    throw new CoreError('duplicate_attachment')
  }

  const unique = [
    ...new Map(assets.map((item) => [item.reference.id, item])).values()
  ]

  validateMediaTotal(unique, worker.maxTotalMediaBytes)
  return { attachments: media, stored: unique }
}

export async function readPreview(
  storage: Storage,
  requestId: string,
  media: StoredMedia,
  maximum: number
): Promise<StoredMedia | undefined> {
  const id = media.reference.previewMediaId
  if (id === undefined) {
    return undefined
  }
  mediaId.parse(id)
  const preview = await storage.media?.get(requestId, id)
  if (
    preview?.reference.kind !== 'image' ||
    preview.reference.previewMediaId !== undefined
  ) {
    throw new CoreError('invalid_media_preview')
  }
  return verifiedMedia(preview, preview.reference, maximum)
}
