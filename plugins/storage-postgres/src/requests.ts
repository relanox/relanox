import {
  validateIncoming,
  validateMessageMedia,
  encodeDurableRecord,
  messageDigest,
  matchesInitialMessage,
  isRequestInScope
} from '@relanox/storage-support'
import { readMedia, insertIncomingMedia } from './media.js'
import type { Storage, InboundRecord } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'

export function createRequestOperations(
  context: DatabaseContext
): Pick<Storage, 'acceptInbound' | 'enqueueMessage'> {
  const { query, transaction, readInbound } = context
  return {
    async acceptInbound(snapshot, media = []) {
      return transaction(async (client) => {
        const existing = (
          await query<{ id: string }>(
            client,
            'SELECT id FROM inbound WHERE channel=$1 AND account=$2 AND event=$3',
            [
              snapshot.source.channel,
              snapshot.source.accountId,
              snapshot.source.eventId
            ]
          )
        )[0]

        if (existing) {
          return { requestId: existing.id, duplicate: true }
        }
        validateIncoming(snapshot, media)

        const record: InboundRecord = {
          snapshot,
          version: 1,
          dispatch: { status: 'due', attempts: 0, dueAt: snapshot.acceptedAt }
        }

        const inserted = await query<{ id: string }>(
          client,
          `
            INSERT INTO inbound(id,channel,account,event,endpoint,accepted_at,status,version,record)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
            ON CONFLICT(channel,account,event) DO NOTHING
            RETURNING id
          `,
          [
            snapshot.requestId,
            snapshot.source.channel,
            snapshot.source.accountId,
            snapshot.source.eventId,
            snapshot.endpoint.id,
            snapshot.acceptedAt,
            record.dispatch.status,
            1,
            encodeDurableRecord(record)
          ]
        )

        if (inserted.length > 0) {
          await insertIncomingMedia(context, client, snapshot.requestId, media)
          return { requestId: snapshot.requestId, duplicate: false }
        }

        const original = (
          await query<{ id: string }>(
            client,
            'SELECT id FROM inbound WHERE channel=$1 AND account=$2 AND event=$3',
            [
              snapshot.source.channel,
              snapshot.source.accountId,
              snapshot.source.eventId
            ]
          )
        )[0]

        if (!original) {
          throw new Error('Concurrent source key is unavailable')
        }
        return { requestId: original.id, duplicate: true }
      })
    },
    async enqueueMessage(input) {
      return transaction(async (client) => {
        const record = await readInbound(client, input.requestId)
        if (!record) {
          return { status: 'not_found' }
        }
        if (!isRequestInScope(record, input)) {
          return { status: 'unauthorized' }
        }

        const previous = (
          await query<{ id: string; digest: string }>(
            client,
            'SELECT id,digest FROM outbound WHERE request_id=$1 AND message_id=$2',
            [input.requestId, input.message.messageId]
          )
        )[0]

        const digest = messageDigest(input.message)
        if (previous) {
          return previous.digest === digest
            ? { status: 'queued', deliveryId: previous.id, replay: true }
            : { status: 'conflict' }
        }
        if (
          record.redactedAt !== undefined ||
          !matchesInitialMessage(input.outbound, record, input)
        ) {
          return { status: 'conflict' }
        }

        const rows = await query<{ id: string }>(
          client,
          'SELECT id FROM media WHERE request_id=$1 AND data IS NOT NULL',
          [input.requestId]
        )

        const assets = []
        for (const { id } of rows) {
          const asset = await readMedia(context, client, input.requestId, id)
          if (asset) {
            assets.push(asset)
          }
        }
        const additions = validateMessageMedia(input, assets)
        if (!additions) {
          return { status: 'conflict' }
        }

        const collisions = await query(
          client,
          'SELECT id FROM media WHERE id=ANY($1::text[])',
          [additions.map((asset) => asset.reference.id)]
        )

        if (collisions.length > 0) {
          return { status: 'conflict' }
        }
        const delivery = input.outbound

        const inserted = await query(
          client,
          'INSERT INTO outbound(id,request_id,message_id,digest,status,version,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING RETURNING id',
          [
            delivery.deliveryId,
            input.requestId,
            input.message.messageId,
            digest,
            delivery.status,
            1,
            encodeDurableRecord(delivery)
          ]
        )

        if (inserted.length === 0) {
          return { status: 'conflict' }
        }
        await insertIncomingMedia(context, client, input.requestId, additions)
        return {
          status: 'queued',
          deliveryId: delivery.deliveryId,
          replay: false
        }
      })
    }
  }
}
