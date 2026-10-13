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
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import {
  conversations,
  inbound,
  outbound,
  media as mediaTable
} from './schema.js'

export function createRequestOperations(
  context: DatabaseContext
): Pick<Storage, 'acceptInbound' | 'enqueueMessage' | 'getMessageReceipt'> {
  const { db, transaction, readConversation } = context
  return {
    async acceptInbound(snapshot, media = []) {
      return transaction(() => {
        const row = db
          .select({ id: inbound.id })
          .from(inbound)
          .where(
            and(
              eq(inbound.channel, snapshot.source.channel),
              eq(inbound.account, snapshot.source.accountId),
              eq(inbound.event, snapshot.source.eventId)
            )
          )
          .get()

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

        db.insert(inbound)
          .values({
            id: snapshot.requestId,
            channel: snapshot.source.channel,
            account: snapshot.source.accountId,
            event: snapshot.source.eventId,
            endpoint: snapshot.endpoint.id,
            acceptedAt: snapshot.acceptedAt,
            status: record.dispatch.status,
            version: 1,
            record: encodeDurableRecord(record)
          })
          .run()
        db.update(conversations)
          .set({
            record: encodeDurableRecord({
              ...conversation,
              target: snapshot.target
            })
          })
          .where(eq(conversations.id, snapshot.channel.id))
          .run()
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
          .select({ id: outbound.id, digest: outbound.digest })
          .from(outbound)
          .where(
            and(
              eq(outbound.channelId, input.channelId),
              eq(outbound.messageId, input.message.messageId)
            )
          )
          .get()

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
          .select({ id: outbound.id, digest: outbound.digest })
          .from(outbound)
          .where(
            and(
              eq(outbound.channelId, input.channelId),
              eq(outbound.messageId, input.message.messageId)
            )
          )
          .get()

        const digest = messageDigest(input.message)
        if (previous) {
          return previous.digest === digest
            ? { status: 'queued', deliveryId: previous.id, replay: true }
            : { status: 'conflict' }
        }
        if (!matchesInitialMessage(input.outbound, record, input)) {
          return { status: 'conflict' }
        }

        const assets = db
          .select({ id: mediaTable.id })
          .from(mediaTable)
          .where(
            and(
              eq(mediaTable.channelId, input.channelId),
              inArray(mediaTable.id, messageMediaIds(input)),
              isNotNull(mediaTable.data)
            )
          )
          .all()
          .flatMap(({ id }) => {
            const asset = readMedia(context, input.channelId, id)
            return asset ? [asset] : []
          })

        const additions = validateMessageMedia(input, assets)
        if (
          !additions ||
          additions.some(
            (asset) =>
              db
                .select({ id: mediaTable.id })
                .from(mediaTable)
                .where(eq(mediaTable.id, asset.reference.id))
                .get() !== undefined
          ) ||
          db
            .select({ id: outbound.id })
            .from(outbound)
            .where(eq(outbound.id, input.outbound.deliveryId))
            .get() !== undefined
        ) {
          return { status: 'conflict' }
        }
        const delivery = input.outbound
        db.insert(outbound)
          .values({
            id: delivery.deliveryId,
            channelId: input.channelId,
            messageId: input.message.messageId,
            digest,
            status: delivery.status,
            version: 1,
            record: encodeDurableRecord(delivery)
          })
          .run()
        insertIncomingMedia(context, input.channelId, additions)
        db.update(mediaTable)
          .set({ staged: 0 })
          .where(
            and(
              eq(mediaTable.channelId, input.channelId),
              inArray(
                mediaTable.id,
                input.message.attachments?.flatMap((ref) => [
                  ref.id,
                  ...(ref.previewMediaId ? [ref.previewMediaId] : [])
                ]) ?? []
              )
            )
          )
          .run()
        return {
          status: 'queued',
          deliveryId: delivery.deliveryId,
          replay: false
        }
      })
    }
  }
}
