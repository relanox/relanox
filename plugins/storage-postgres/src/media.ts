import {
  encodeDurableRecord,
  mediaDigest,
  isConversationInScope,
  validateStagedMedia
} from '@relanox/storage-support'
import type { MediaStorage, StoredMedia, MediaReference } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import type { Pool, PoolClient } from 'pg'

export async function readMedia(
  context: DatabaseContext,
  client: Pool | PoolClient,
  channelId: string,
  mediaId: string
): Promise<StoredMedia | undefined> {
  const row = (
    await context.query<{ reference: MediaReference; data: Buffer }>(
      client,
      'SELECT reference,data FROM media WHERE channel_id=$1 AND id=$2 AND data IS NOT NULL',
      [channelId, mediaId]
    )
  )[0]

  return row
    ? { reference: row.reference, data: new Uint8Array(row.data) }
    : undefined
}

export async function insertIncomingMedia(
  context: DatabaseContext,
  client: PoolClient,
  channelId: string,
  assets: readonly StoredMedia[],
  staged = false
): Promise<void> {
  for (const asset of assets) {
    await client.query(
      'INSERT INTO media(id,channel_id,reference,data,digest,staged,created_at) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)',
      [
        asset.reference.id,
        channelId,
        encodeDurableRecord(asset.reference),
        Buffer.from(asset.data),
        mediaDigest(asset),
        staged,
        Date.now()
      ]
    )
  }
}

export function createMediaOperations(context: DatabaseContext): MediaStorage {
  const reference = async (
    client: PoolClient,
    channelId: string,
    id: string
  ): Promise<MediaReference | undefined> =>
    (
      await context.query<{ reference: MediaReference }>(
        client,
        'SELECT reference FROM media WHERE channel_id=$1 AND id=$2 AND data IS NOT NULL',
        [channelId, id]
      )
    )[0]?.reference

  return {
    async getReference(channelId, id) {
      return (
        await context.query<{ reference: MediaReference }>(
          context.pool,
          'SELECT reference FROM media WHERE channel_id=$1 AND id=$2',
          [channelId, id]
        )
      )[0]?.reference
    },
    async get(channelId, mediaId) {
      return readMedia(context, context.pool, channelId, mediaId)
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
          (await client.query('SELECT id FROM media WHERE id=$1', [id]))
            .rowCount
        ) {
          return { status: 'conflict' }
        }

        const totals = (
          await context.query<{ count: string; bytes: string }>(
            client,
            'SELECT count(*) AS count, coalesce(sum(octet_length(data)),0) AS bytes FROM media WHERE channel_id=$1 AND data IS NOT NULL AND staged=TRUE',
            [input.channelId]
          )
        )[0]

        const previewId = input.media.reference.previewMediaId

        const result = validateStagedMedia(
          input,
          previous,
          previewId === undefined
            ? undefined
            : await reference(client, input.channelId, previewId),
          Number(totals?.count ?? 0),
          Number(totals?.bytes ?? 0)
        )

        if (result.status === 'stored' && !previous) {
          const inserted = await client.query(
            'INSERT INTO media(id,channel_id,reference,data,digest,staged,created_at) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
            [
              id,
              input.channelId,
              encodeDurableRecord(input.media.reference),
              Buffer.from(input.media.data),
              mediaDigest(input.media),
              true,
              Date.now()
            ]
          )

          if (inserted.rowCount !== 1) {
            return { status: 'conflict' }
          }
        }
        return result
      })
    }
  }
}
