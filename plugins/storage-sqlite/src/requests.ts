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
import { needsPreparation } from '@relanox/sdk'
import { readMedia, insertIncomingMedia } from './media.js'
import type {
  Storage,
  InboundRecord,
  OutboundMessage,
  ConversationRecord
} from '@relanox/sdk'
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
          reply: {},
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

        const { finalId, valid } = resolveReply(context, record, input.message)
        if (!valid) {
          return { status: 'not_found' }
        }

        const previous = db
          .select({ id: outbound.id, digest: outbound.digest })
          .from(outbound)
          .where(
            finalId
              ? eq(outbound.id, finalId)
              : and(
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

        const { source, finalId, valid } = resolveReply(
          context,
          record,
          input.message
        )

        if (!valid) {
          return { status: 'not_found' }
        }

        const previous = db
          .select({ id: outbound.id, digest: outbound.digest })
          .from(outbound)
          .where(
            finalId
              ? eq(outbound.id, finalId)
              : and(
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
        if (source?.redactedAt !== undefined) {
          return { status: 'not_found' }
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
        if (source && input.message.reply?.kind === 'final') {
          context.saveInbound({
            ...source,
            version: source.version + 1,
            reply: { finalDeliveryId: delivery.deliveryId }
          })
        }
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

function resolveReply(
  context: DatabaseContext,
  conversation: ConversationRecord,
  message: OutboundMessage
): {
  source: InboundRecord | undefined
  valid: boolean
  finalId: string | undefined
} {
  const source = message.reply
    ? context.readInbound(message.reply.requestId)
    : undefined

  return {
    source,
    valid:
      !message.reply ||
      (source !== undefined &&
        !needsPreparation(source) &&
        validConversationInbound(source.snapshot, conversation)),
    finalId:
      message.reply?.kind === 'final'
        ? source?.reply?.finalDeliveryId
        : undefined
  }
}
