import {
  encodeDurableRecord,
  mediaDigest,
  isConversationInScope,
  validateStagedMedia
} from '@relanox/storage-support'
import { decodeDurableRecord } from './record-codec.js'
import type { MediaStorage, StoredMedia, MediaReference } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'

export function readMedia(
  context: DatabaseContext,
  channelId: string,
  mediaId: string
): StoredMedia | undefined {
  const row = context.db
    .prepare(
      'SELECT reference,data FROM media WHERE channel_id=? AND id=? AND data IS NOT NULL'
    )
    .get(channelId, mediaId) as { reference: string; data: Buffer } | undefined

  return row
    ? {
        reference: decodeDurableRecord(row.reference),
        data: new Uint8Array(row.data)
      }
    : undefined
}

export function insertIncomingMedia(
  context: DatabaseContext,
  channelId: string,
  assets: readonly StoredMedia[],
  staged = false
): void {
  for (const asset of assets) {
    context.db
      .prepare(
        'INSERT INTO media(id,channel_id,reference,data,digest,staged,created_at) VALUES(?,?,?,?,?,?,?)'
      )
      .run(
        asset.reference.id,
        channelId,
        encodeDurableRecord(asset.reference),
        Buffer.from(asset.data),
        mediaDigest(asset),
        staged ? 1 : 0,
        Date.now()
      )
  }
}

export function createMediaOperations(context: DatabaseContext): MediaStorage {
  const reference = (
    channelId: string,
    id: string
  ): MediaReference | undefined => {
    const row = context.db
      .prepare(
        'SELECT reference FROM media WHERE channel_id=? AND id=? AND data IS NOT NULL'
      )
      .get(channelId, id) as { reference: string } | undefined

    return row ? decodeDurableRecord(row.reference) : undefined
  }

  return {
    async getReference(channelId, id) {
      const row = context.db
        .prepare('SELECT reference FROM media WHERE channel_id=? AND id=?')
        .get(channelId, id) as { reference: string } | undefined

      return row ? decodeDurableRecord(row.reference) : undefined
    },
    async get(channelId, mediaId) {
      return readMedia(context, channelId, mediaId)
    },
    async put(input) {
      return context.transaction(() => {
        const request = context.readConversation(input.channelId)
        if (!request || !isConversationInScope(request, input)) {
          return { status: 'unauthorized' }
        }
        const id = input.media.reference.id
        const previous = reference(input.channelId, id)
        if (
          !previous &&
          context.db.prepare('SELECT id FROM media WHERE id=?').get(id) !==
            undefined
        ) {
          return { status: 'conflict' }
        }

        const totals = context.db
          .prepare(
            'SELECT count(*) AS count, coalesce(sum(length(data)),0) AS bytes FROM media WHERE channel_id=? AND data IS NOT NULL AND staged=1'
          )
          .get(input.channelId) as { count: number; bytes: number }

        const previewId = input.media.reference.previewMediaId

        const result = validateStagedMedia(
          input,
          previous,
          previewId === undefined
            ? undefined
            : reference(input.channelId, previewId),
          totals.count,
          totals.bytes
        )

        if (result.status === 'stored' && !previous) {
          insertIncomingMedia(context, input.channelId, [input.media], true)
        }
        return result
      })
    }
  }
}
