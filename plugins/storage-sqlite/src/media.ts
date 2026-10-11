import {
  encodeDurableRecord,
  mediaDigest,
  isRequestInScope,
  validateStagedMedia
} from '@relanox/storage-support'
import { decodeDurableRecord } from './record-codec.js'
import type { MediaStorage, StoredMedia, MediaReference } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'

export function readMedia(
  context: DatabaseContext,
  requestId: string,
  mediaId: string
): StoredMedia | undefined {
  const row = context.db
    .prepare(
      'SELECT reference,data FROM media WHERE request_id=? AND id=? AND data IS NOT NULL'
    )
    .get(requestId, mediaId) as { reference: string; data: Buffer } | undefined

  return row
    ? {
        reference: decodeDurableRecord(row.reference),
        data: new Uint8Array(row.data)
      }
    : undefined
}

export function insertIncomingMedia(
  context: DatabaseContext,
  requestId: string,
  assets: readonly StoredMedia[]
): void {
  for (const asset of assets) {
    context.db
      .prepare(
        'INSERT INTO media(id,request_id,reference,data,digest) VALUES(?,?,?,?,?)'
      )
      .run(
        asset.reference.id,
        requestId,
        encodeDurableRecord(asset.reference),
        Buffer.from(asset.data),
        mediaDigest(asset)
      )
  }
}

export function createMediaOperations(context: DatabaseContext): MediaStorage {
  const reference = (
    requestId: string,
    id: string
  ): MediaReference | undefined => {
    const row = context.db
      .prepare(
        'SELECT reference FROM media WHERE request_id=? AND id=? AND data IS NOT NULL'
      )
      .get(requestId, id) as { reference: string } | undefined

    return row ? decodeDurableRecord(row.reference) : undefined
  }

  return {
    async get(requestId, mediaId) {
      return readMedia(context, requestId, mediaId)
    },
    async put(input) {
      return context.transaction(() => {
        const request = context.readInbound(input.requestId)
        if (
          !request ||
          !isRequestInScope(request, input) ||
          request.redactedAt !== undefined
        ) {
          return { status: 'unauthorized' }
        }
        const id = input.media.reference.id
        const previous = reference(input.requestId, id)
        if (
          !previous &&
          context.db.prepare('SELECT id FROM media WHERE id=?').get(id) !==
            undefined
        ) {
          return { status: 'conflict' }
        }

        const totals = context.db
          .prepare(
            'SELECT count(*) AS count, coalesce(sum(length(data)),0) AS bytes FROM media WHERE request_id=? AND data IS NOT NULL'
          )
          .get(input.requestId) as { count: number; bytes: number }

        const previewId = input.media.reference.previewMediaId

        const result = validateStagedMedia(
          input,
          previous,
          previewId === undefined
            ? undefined
            : reference(input.requestId, previewId),
          totals.count,
          totals.bytes
        )

        if (result.status === 'stored' && !previous) {
          insertIncomingMedia(context, input.requestId, [input.media])
        }
        return result
      })
    }
  }
}
