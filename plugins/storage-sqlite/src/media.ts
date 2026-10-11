import { encodeDurableRecord, mediaDigest } from '@relanox/storage-support'
import { decodeDurableRecord } from './record-codec.js'
import type { MediaStorage, StoredMedia } from '@relanox/sdk'
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
  return {
    async get(requestId, mediaId) {
      return readMedia(context, requestId, mediaId)
    }
  }
}
