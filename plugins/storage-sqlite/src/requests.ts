import {
  validateIncoming,
  validateMessageMedia,
  encodeDurableRecord,
  messageDigest,
  matchesInitialMessage,
  isRequestInScope
} from '@relanox/storage-support'
import { decodeDurableRecord } from './record-codec.js'
import { readMedia, insertIncomingMedia } from './media.js'
import type { Storage, InboundRecord } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'

export function createRequestOperations(
  context: DatabaseContext
): Pick<Storage, 'acceptInbound' | 'enqueueMessage'> {
  const { db, transaction, readInbound } = context
  return {
    async acceptInbound(snapshot, media = []) {
      return transaction(() => {
        const row = db
          .prepare(
            'SELECT id FROM inbound WHERE channel=? AND account=? AND event=?'
          )
          .get(
            snapshot.source.channel,
            snapshot.source.accountId,
            snapshot.source.eventId
          ) as { id: string } | undefined

        if (row) {
          return { requestId: row.id, duplicate: true }
        }
        validateIncoming(snapshot, media)

        const record: InboundRecord = {
          snapshot: decodeDurableRecord(encodeDurableRecord(snapshot)),
          version: 1,
          dispatch: { status: 'due', attempts: 0, dueAt: snapshot.acceptedAt }
        }

        db.prepare(
          `
            INSERT INTO inbound(id,channel,account,event,endpoint,accepted_at,status,version,record)
            VALUES(?,?,?,?,?,?,?,?,?)
          `
        ).run(
          snapshot.requestId,
          snapshot.source.channel,
          snapshot.source.accountId,
          snapshot.source.eventId,
          snapshot.endpoint.id,
          snapshot.acceptedAt,
          record.dispatch.status,
          1,
          encodeDurableRecord(record)
        )
        insertIncomingMedia(context, snapshot.requestId, media)
        return { requestId: snapshot.requestId, duplicate: false }
      })
    },
    async enqueueMessage(input) {
      return transaction(() => {
        const record = readInbound(input.requestId)
        if (!record) {
          return { status: 'not_found' }
        }
        if (!isRequestInScope(record, input)) {
          return { status: 'unauthorized' }
        }

        const previous = db
          .prepare(
            'SELECT id,digest FROM outbound WHERE request_id=? AND message_id=?'
          )
          .get(input.requestId, input.message.messageId) as
          { id: string; digest: string } | undefined

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

        const assets = (
          db
            .prepare(
              'SELECT id FROM media WHERE request_id=? AND data IS NOT NULL'
            )
            .all(input.requestId) as { id: string }[]
        ).flatMap(({ id }) => {
          const asset = readMedia(context, input.requestId, id)
          return asset ? [asset] : []
        })

        const additions = validateMessageMedia(input, assets)
        if (
          !additions ||
          additions.some(
            (asset) =>
              db
                .prepare('SELECT id FROM media WHERE id=?')
                .get(asset.reference.id) !== undefined
          ) ||
          db
            .prepare('SELECT id FROM outbound WHERE id=?')
            .get(input.outbound.deliveryId) !== undefined
        ) {
          return { status: 'conflict' }
        }
        const delivery = input.outbound
        db.prepare(
          'INSERT INTO outbound(id,request_id,message_id,digest,status,version,record) VALUES(?,?,?,?,?,?,?)'
        ).run(
          delivery.deliveryId,
          input.requestId,
          input.message.messageId,
          digest,
          delivery.status,
          1,
          encodeDurableRecord(delivery)
        )
        insertIncomingMedia(context, input.requestId, additions)
        return {
          status: 'queued',
          deliveryId: delivery.deliveryId,
          replay: false
        }
      })
    }
  }
}
