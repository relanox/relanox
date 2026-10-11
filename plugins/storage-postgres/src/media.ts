import {
  encodeDurableRecord,
  mediaDigest,
  isRequestInScope,
  validateStagedMedia
} from '@relanox/storage-support'
import type { MediaStorage, StoredMedia, MediaReference } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import type { Pool, PoolClient } from 'pg'

export async function readMedia(
  context: DatabaseContext,
  client: Pool | PoolClient,
  requestId: string,
  mediaId: string
): Promise<StoredMedia | undefined> {
  const row = (
    await context.query<{ reference: MediaReference; data: Buffer }>(
      client,
      'SELECT reference,data FROM media WHERE request_id=$1 AND id=$2 AND data IS NOT NULL',
      [requestId, mediaId]
    )
  )[0]

  return row
    ? { reference: row.reference, data: new Uint8Array(row.data) }
    : undefined
}

export async function insertIncomingMedia(
  context: DatabaseContext,
  client: PoolClient,
  requestId: string,
  assets: readonly StoredMedia[]
): Promise<void> {
  for (const asset of assets) {
    await client.query(
      'INSERT INTO media(id,request_id,reference,data,digest) VALUES($1,$2,$3::jsonb,$4,$5)',
      [
        asset.reference.id,
        requestId,
        encodeDurableRecord(asset.reference),
        Buffer.from(asset.data),
        mediaDigest(asset)
      ]
    )
  }
}

export function createMediaOperations(context: DatabaseContext): MediaStorage {
  const reference = async (
    client: PoolClient,
    requestId: string,
    id: string
  ): Promise<MediaReference | undefined> =>
    (
      await context.query<{ reference: MediaReference }>(
        client,
        'SELECT reference FROM media WHERE request_id=$1 AND id=$2 AND data IS NOT NULL',
        [requestId, id]
      )
    )[0]?.reference

  return {
    async get(requestId, mediaId) {
      return readMedia(context, context.pool, requestId, mediaId)
    },
    async put(input) {
      return context.transaction(async (client) => {
        const request = await context.readInbound(client, input.requestId)
        if (
          !request ||
          !isRequestInScope(request, input) ||
          request.redactedAt !== undefined
        ) {
          return { status: 'unauthorized' }
        }
        const id = input.media.reference.id
        const previous = await reference(client, input.requestId, id)
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
            'SELECT count(*) AS count, coalesce(sum(octet_length(data)),0) AS bytes FROM media WHERE request_id=$1 AND data IS NOT NULL',
            [input.requestId]
          )
        )[0]

        const previewId = input.media.reference.previewMediaId

        const result = validateStagedMedia(
          input,
          previous,
          previewId === undefined
            ? undefined
            : await reference(client, input.requestId, previewId),
          Number(totals?.count ?? 0),
          Number(totals?.bytes ?? 0)
        )

        if (result.status === 'stored' && !previous) {
          const inserted = await client.query(
            'INSERT INTO media(id,request_id,reference,data,digest) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(id) DO NOTHING',
            [
              id,
              input.requestId,
              encodeDurableRecord(input.media.reference),
              Buffer.from(input.media.data),
              mediaDigest(input.media)
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
