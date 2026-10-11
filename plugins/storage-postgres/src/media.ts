import { encodeDurableRecord, mediaDigest } from '@relanox/storage-support'
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
  return {
    async get(requestId, mediaId) {
      return readMedia(context, context.pool, requestId, mediaId)
    }
  }
}
