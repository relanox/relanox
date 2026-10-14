import {
  validateIncoming,
  validateMessageMedia,
  messageMediaIds,
  messageDigest,
  matchesInitialMessage,
  isConversationInScope,
  validConversationInbound
} from '@relanox/storage-support'
import { readMedia, insertIncomingMedia } from './media.js'
import { needsTranscription } from '@relanox/sdk'
import type {
  Storage,
  InboundRecord,
  OutboundMessage,
  ConversationRecord
} from '@relanox/sdk'
import type { DatabaseContext, Database } from './database.js'
import { durable } from './database.js'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import {
  inbound,
  outbound,
  conversations,
  media as mediaTable
} from './schema.js'

export function createRequestOperations(
  context: DatabaseContext
): Pick<Storage, 'acceptInbound' | 'enqueueMessage' | 'getMessageReceipt'> {
  const { transaction, readConversation } = context
  return {
    async acceptInbound(snapshot, media = []) {
      return transaction(async (client) => {
        const sourceKey = and(
          eq(inbound.channel, snapshot.source.channel),
          eq(inbound.account, snapshot.source.accountId),
          eq(inbound.event, snapshot.source.eventId)
        )

        const existing = (
          await client.select({ id: inbound.id }).from(inbound).where(sourceKey)
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
          reply: {},
          dispatch: { status: 'due', attempts: 0, dueAt: snapshot.acceptedAt }
        }

        const inserted = await client
          .insert(inbound)
          .values({
            id: snapshot.requestId,
            channel: snapshot.source.channel,
            account: snapshot.source.accountId,
            event: snapshot.source.eventId,
            endpoint: snapshot.endpoint.id,
            acceptedAt: snapshot.acceptedAt,
            status: record.dispatch.status,
            version: 1,
            record: durable(record)
          })
          .onConflictDoNothing({
            target: [inbound.channel, inbound.account, inbound.event]
          })
          .returning({ id: inbound.id })

        if (inserted.length > 0) {
          await client
            .update(conversations)
            .set({
              record: durable({ ...conversation, target: snapshot.target })
            })
            .where(eq(conversations.id, snapshot.channel.id))
          await insertIncomingMedia(context, client, snapshot.channel.id, media)
          return { requestId: snapshot.requestId, duplicate: false }
        }

        const original = (
          await client.select({ id: inbound.id }).from(inbound).where(sourceKey)
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

        const { finalId, valid } = await resolveReply(
          context,
          client,
          record,
          input.message
        )

        if (!valid) {
          return { status: 'not_found' }
        }

        const previous = (
          await client
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

        const { source, finalId, valid } = await resolveReply(
          context,
          client,
          record,
          input.message
        )

        if (!valid) {
          return { status: 'not_found' }
        }

        const previous = (
          await client
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
        )[0]

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

        const rows = await client
          .select({ id: mediaTable.id })
          .from(mediaTable)
          .where(
            and(
              eq(mediaTable.channelId, input.channelId),
              inArray(mediaTable.id, messageMediaIds(input)),
              isNotNull(mediaTable.data)
            )
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

        const collisions = await client
          .select({ id: mediaTable.id })
          .from(mediaTable)
          .where(
            inArray(
              mediaTable.id,
              additions.map((asset) => asset.reference.id)
            )
          )

        if (collisions.length > 0) {
          return { status: 'conflict' }
        }
        const delivery = input.outbound

        const inserted = await client
          .insert(outbound)
          .values({
            id: delivery.deliveryId,
            channelId: input.channelId,
            messageId: input.message.messageId,
            digest,
            status: delivery.status,
            version: 1,
            record: durable(delivery)
          })
          .onConflictDoNothing()
          .returning({ id: outbound.id })

        if (inserted.length === 0) {
          return { status: 'conflict' }
        }
        if (source && input.message.reply?.kind === 'final') {
          await context.saveInbound(client, {
            ...source,
            version: source.version + 1,
            reply: { finalDeliveryId: delivery.deliveryId }
          })
        }
        await insertIncomingMedia(context, client, input.channelId, additions)
        await client
          .update(mediaTable)
          .set({ staged: false })
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

async function resolveReply(
  context: DatabaseContext,
  client: Database,
  conversation: ConversationRecord,
  message: OutboundMessage
): Promise<{
  source: InboundRecord | undefined
  valid: boolean
  finalId: string | undefined
}> {
  const source = message.reply
    ? await context.readInbound(client, message.reply.requestId)
    : undefined

  return {
    source,
    valid:
      !message.reply ||
      (source !== undefined &&
        !needsTranscription(source) &&
        validConversationInbound(source.snapshot, conversation)),
    finalId:
      message.reply?.kind === 'final'
        ? source?.reply?.finalDeliveryId
        : undefined
  }
}
