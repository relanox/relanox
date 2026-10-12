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
import { readMedia, insertIncomingMedia } from './media.js'
import type { Storage, InboundRecord } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'

export function createRequestOperations(
  context: DatabaseContext
): Pick<Storage, 'acceptInbound' | 'enqueueMessage' | 'getMessageReceipt'> {
  const { query, transaction, readConversation } = context
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
        const conversation = await readConversation(client, snapshot.channel.id)
        if (!validConversationInbound(snapshot, conversation)) {
          throw new Error('Unauthorized inbound conversation')
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
          await client.query(
            'UPDATE conversations SET record=$1::jsonb WHERE id=$2',
            [
              encodeDurableRecord({ ...conversation, target: snapshot.target }),
              snapshot.channel.id
            ]
          )
          await insertIncomingMedia(context, client, snapshot.channel.id, media)
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
    async getMessageReceipt(input) {
      return transaction(async (client) => {
        const record = await readConversation(client, input.channelId)
        if (!record || !isConversationInScope(record, input)) {
          return { status: 'not_found' }
        }

        const previous = (
          await query<{ id: string; digest: string }>(
            client,
            'SELECT id,digest FROM outbound WHERE channel_id=$1 AND message_id=$2',
            [input.channelId, input.message.messageId]
          )
        )[0]

        if (!previous) {
          return { status: 'not_found' }
        }
        return previous.digest === messageDigest(input.message)
          ? { status: 'queued', deliveryId: previous.id, replay: true }
          : { status: 'conflict' }
      })
    },
    async enqueueMessage(input) {
      return transaction(async (client) => {
        const record = await readConversation(client, input.channelId)
        if (!record) {
          return { status: 'not_found' }
        }
        if (!isConversationInScope(record, input)) {
          return { status: 'unauthorized' }
        }

        const previous = (
          await query<{ id: string; digest: string }>(
            client,
            'SELECT id,digest FROM outbound WHERE channel_id=$1 AND message_id=$2',
            [input.channelId, input.message.messageId]
          )
        )[0]

        const digest = messageDigest(input.message)
        if (previous) {
          return previous.digest === digest
            ? { status: 'queued', deliveryId: previous.id, replay: true }
            : { status: 'conflict' }
        }
        if (!matchesInitialMessage(input.outbound, record, input)) {
          return { status: 'conflict' }
        }

        const rows = await query<{ id: string }>(
          client,
          'SELECT id FROM media WHERE channel_id=$1 AND id=ANY($2::text[]) AND data IS NOT NULL',
          [input.channelId, messageMediaIds(input)]
        )

        const assets = []
        for (const { id } of rows) {
          const asset = await readMedia(context, client, input.channelId, id)
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
          'INSERT INTO outbound(id,channel_id,message_id,digest,status,version,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING RETURNING id',
          [
            delivery.deliveryId,
            input.channelId,
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
        await insertIncomingMedia(context, client, input.channelId, additions)
        await client.query(
          'UPDATE media SET staged=FALSE WHERE channel_id=$1 AND id=ANY($2::text[])',
          [
            input.channelId,
            input.message.attachments?.flatMap((ref) => [
              ref.id,
              ...(ref.previewMediaId ? [ref.previewMediaId] : [])
            ]) ?? []
          ]
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

export { createConversationOperations } from './conversations.js'
