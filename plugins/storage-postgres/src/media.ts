import {
  mediaDigest,
  isConversationInScope,
  validateStagedMedia
} from '@relanox/storage-support'
import type { MediaStorage, StoredMedia, MediaReference } from '@relanox/sdk'
import type { Database, DatabaseContext } from './database.js'
import { durable } from './database.js'
import { and, count, eq, isNotNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { media } from './schema.js'

function liveMedia(channelId: string, mediaId: string): SQL | undefined {
  return and(
    eq(media.channelId, channelId),
    eq(media.id, mediaId),
    isNotNull(media.data)
  )
}

export async function readMedia(
  context: DatabaseContext,
  client: Database,
  channelId: string,
  mediaId: string
): Promise<StoredMedia | undefined> {
  const row = (
    await client
      .select({ reference: media.reference, data: media.data })
      .from(media)
      .where(liveMedia(channelId, mediaId))
  )[0]

  return row?.data
    ? { reference: row.reference, data: new Uint8Array(row.data) }
    : undefined
}

function mediaValues(
  channelId: string,
  asset: StoredMedia,
  staged: boolean
): typeof media.$inferInsert {
  return {
    id: asset.reference.id,
    channelId,
    reference: durable(asset.reference),
    data: Buffer.from(asset.data),
    digest: mediaDigest(asset),
    staged,
    createdAt: Date.now()
  }
}

export async function insertIncomingMedia(
  context: DatabaseContext,
  client: Database,
  channelId: string,
  assets: readonly StoredMedia[],
  staged = false
): Promise<void> {
  for (const asset of assets) {
    await client.insert(media).values(mediaValues(channelId, asset, staged))
  }
}

export function createMediaOperations(context: DatabaseContext): MediaStorage {
  const reference = async (
    client: Database,
    channelId: string,
    id: string
  ): Promise<MediaReference | undefined> =>
    (
      await client
        .select({ reference: media.reference })
        .from(media)
        .where(liveMedia(channelId, id))
    )[0]?.reference

  return {
    async getReference(channelId, id) {
      return (
        await context.db
          .select({ reference: media.reference })
          .from(media)
          .where(and(eq(media.channelId, channelId), eq(media.id, id)))
      )[0]?.reference
    },
    async get(channelId, mediaId) {
      return readMedia(context, context.db, channelId, mediaId)
    },
    async put(input) {
      return context.transaction(async (client) => {
        const request = await context.readConversation(client, input.channelId)
        if (!request || !isConversationInScope(request, input)) {
          return { status: 'unauthorized' }
        }
        const id = input.media.reference.id
        const previous = await reference(client, input.channelId, id)
        if (
          !previous &&
          (
            await client
              .select({ id: media.id })
              .from(media)
              .where(eq(media.id, id))
          ).length > 0
        ) {
          return { status: 'conflict' }
        }

        const totals = (
          await client
            .select({
              count: count(),
              bytes:
                sql<number>`coalesce(sum(octet_length(${media.data})), 0)`.mapWith(
                  Number
                )
            })
            .from(media)
            .where(
              and(
                eq(media.channelId, input.channelId),
                isNotNull(media.data),
                eq(media.staged, true)
              )
            )
        )[0]

        const previewId = input.media.reference.previewMediaId

        const result = validateStagedMedia(
          input,
          previous,
          previewId === undefined
            ? undefined
            : await reference(client, input.channelId, previewId),
          totals?.count ?? 0,
          totals?.bytes ?? 0
        )

        if (result.status === 'stored' && !previous) {
          const inserted = await client
            .insert(media)
            .values(mediaValues(input.channelId, input.media, true))
            .onConflictDoNothing({ target: media.id })
            .returning({ id: media.id })

          if (inserted.length !== 1) {
            return { status: 'conflict' }
          }
        }
        return result
      })
    }
  }
}
