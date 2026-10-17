import {
  encodeDurableRecord,
  mediaDigest,
  isConversationInScope,
  validateStagedMedia
} from '@relanox/storage-support'
import { decodeDurableRecord } from './record-codec.js'
import type { MediaStorage, StoredMedia, MediaReference } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { and, count, eq, isNotNull, sum } from 'drizzle-orm'
import { media } from './schema.js'
import { blobLength } from './expressions.js'

export function readMedia(
  context: DatabaseContext,
  channelId: string,
  mediaId: string
): StoredMedia | undefined {
  const row = context.db
    .select({ reference: media.reference, data: media.data })
    .from(media)
    .where(
      and(
        eq(media.channelId, channelId),
        eq(media.id, mediaId),
        isNotNull(media.data)
      )
    )
    .get()

  return row?.data
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
      .insert(media)
      .values({
        id: asset.reference.id,
        channelId,
        reference: encodeDurableRecord(asset.reference),
        data: Buffer.from(asset.data),
        digest: mediaDigest(asset),
        staged: staged ? 1 : 0,
        createdAt: Date.now()
      })
      .run()
  }
}

export function createMediaOperations(context: DatabaseContext): MediaStorage {
  const reference = (
    channelId: string,
    id: string
  ): MediaReference | undefined => {
    const row = context.db
      .select({ reference: media.reference })
      .from(media)
      .where(
        and(
          eq(media.channelId, channelId),
          eq(media.id, id),
          isNotNull(media.data)
        )
      )
      .get()

    return row ? decodeDurableRecord(row.reference) : undefined
  }

  return {
    async getReference(channelId, id) {
      const row = context.db
        .select({ reference: media.reference })
        .from(media)
        .where(and(eq(media.channelId, channelId), eq(media.id, id)))
        .get()

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
          context.db
            .select({ id: media.id })
            .from(media)
            .where(eq(media.id, id))
            .get() !== undefined
        ) {
          return { status: 'conflict' }
        }

        const totals = context.db
          .select({
            count: count(),
            bytes: sum(blobLength(media.data)).mapWith(Number)
          })
          .from(media)
          .where(
            and(
              eq(media.channelId, input.channelId),
              isNotNull(media.data),
              eq(media.staged, 1)
            )
          )
          .get()

        const previewId = input.media.reference.previewMediaId

        const result = validateStagedMedia(
          input,
          previous,
          previewId === undefined
            ? undefined
            : reference(input.channelId, previewId),
          totals?.count ?? 0,
          totals?.bytes ?? 0
        )

        if (result.status === 'stored' && !previous) {
          insertIncomingMedia(context, input.channelId, [input.media], true)
        }
        return result
      })
    }
  }
}
