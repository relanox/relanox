import {
  validateIncoming,
  validateMessageMedia,
  messageMediaIds,
  encodeDurableRecord,
  messageDigest,
  matchesInitialMessage,
  isConversationInScope,
  validConversationInbound
} from '@relanox/storage-support'
import { decodeDurableRecord } from './record-codec.js'
import { readMedia, insertIncomingMedia } from './media.js'
import type { Storage, InboundRecord } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'

export function createRequestOperations(
  context: DatabaseContext
): Pick<Storage, 'acceptInbound' | 'enqueueMessage' | 'getMessageReceipt'> {
  const { db, transaction, readConversation } = context
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
        const conversation = readConversation(snapshot.channel.id)
        if (!validConversationInbound(snapshot, conversation)) {
          throw new Error('Unauthorized inbound conversation')
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
        db.prepare('UPDATE conversations SET record=? WHERE id=?').run(
          encodeDurableRecord({ ...conversation, target: snapshot.target }),
          snapshot.channel.id
        )
        insertIncomingMedia(context, snapshot.channel.id, media)
        return { requestId: snapshot.requestId, duplicate: false }
      })
    },
    async getMessageReceipt(input) {
      return transaction(() => {
        const record = readConversation(input.channelId)
        if (!record || !isConversationInScope(record, input)) {
          return { status: 'not_found' }
        }

        const previous = db
          .prepare(
            'SELECT id,digest FROM outbound WHERE channel_id=? AND message_id=?'
          )
          .get(input.channelId, input.message.messageId) as
          { id: string; digest: string } | undefined

        if (!previous) {
          return { status: 'not_found' }
        }
        return previous.digest === messageDigest(input.message)
          ? { status: 'queued', deliveryId: previous.id, replay: true }
          : { status: 'conflict' }
      })
    },
    async enqueueMessage(input) {
      return transaction(() => {
        const record = readConversation(input.channelId)
        if (!record) {
          return { status: 'not_found' }
        }
        if (!isConversationInScope(record, input)) {
          return { status: 'unauthorized' }
        }

        const previous = db
          .prepare(
            'SELECT id,digest FROM outbound WHERE channel_id=? AND message_id=?'
          )
          .get(input.channelId, input.message.messageId) as
          { id: string; digest: string } | undefined

        const digest = messageDigest(input.message)
        if (previous) {
          return previous.digest === digest
            ? { status: 'queued', deliveryId: previous.id, replay: true }
            : { status: 'conflict' }
        }
        if (!matchesInitialMessage(input.outbound, record, input)) {
          return { status: 'conflict' }
        }

        const assets = (
          db
            .prepare(
              'SELECT id FROM media WHERE channel_id=? AND id IN (SELECT value FROM json_each(?)) AND data IS NOT NULL'
            )
            .all(input.channelId, JSON.stringify(messageMediaIds(input))) as {
            id: string
          }[]
        ).flatMap(({ id }) => {
          const asset = readMedia(context, input.channelId, id)
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
          'INSERT INTO outbound(id,channel_id,message_id,digest,status,version,record) VALUES(?,?,?,?,?,?,?)'
        ).run(
          delivery.deliveryId,
          input.channelId,
          input.message.messageId,
          digest,
          delivery.status,
          1,
          encodeDurableRecord(delivery)
        )
        insertIncomingMedia(context, input.channelId, additions)
        db.prepare(
          'UPDATE media SET staged=0 WHERE channel_id=? AND id IN (SELECT value FROM json_each(?))'
        ).run(
          input.channelId,
          JSON.stringify(
            input.message.attachments?.flatMap((ref) => [
              ref.id,
              ...(ref.previewMediaId ? [ref.previewMediaId] : [])
            ]) ?? []
          )
        )
        return {
          status: 'queued',
          deliveryId: delivery.deliveryId,
          replay: false
        }
      })
    }
  }
}
