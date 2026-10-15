import { chunkMediaReferences } from '@relanox/storage-support'
import { decodeDurableRecord } from './record-codec.js'
import type {
  Storage,
  InboundRecord,
  OutboundRecord,
  MediaReference
} from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  min,
  ne,
  notInArray,
  or,
  sql
} from 'drizzle-orm'
import { inbound, outbound, media, conversations } from './schema.js'
import { jsonValue } from './expressions.js'

const prepared = and(
  or(
    isNull(jsonValue(inbound.record, '$.dispatch.errorCode')),
    ne(jsonValue(inbound.record, '$.dispatch.errorCode'), 'middleware_filtered')
  ),
  or(
    isNull(jsonValue(inbound.record, '$.snapshot.middleware')),
    eq(
      sql<number>`json_array_length(${inbound.record}, '$.snapshot.middleware')`,
      0
    ),
    isNotNull(jsonValue(inbound.record, '$.preparation'))
  )
)

export function createInspectionOperations(
  context: Pick<
    DatabaseContext,
    | 'db'
    | 'transaction'
    | 'readInbound'
    | 'readOutbound'
    | 'saveInbound'
    | 'saveOutbound'
  >
): Pick<
  Storage,
  | 'getInbound'
  | 'getOutbound'
  | 'listInbound'
  | 'listPendingInbound'
  | 'listOutbound'
  | 'getStats'
  | 'cleanup'
> {
  const {
    db,
    transaction,
    readInbound,
    readOutbound,
    saveInbound,
    saveOutbound
  } = context

  return {
    async getInbound(id) {
      return readInbound(id)
    },
    async getOutbound(id) {
      return readOutbound(id)
    },
    async listInbound(filter) {
      if (filter.recent && filter.afterId !== undefined) {
        throw new Error('recent_cursor_unsupported')
      }
      return db
        .select({ record: inbound.record })
        .from(inbound)
        .where(
          and(
            filter.dispatchStatus
              ? eq(inbound.status, filter.dispatchStatus)
              : undefined,
            filter.readyOnly ? prepared : undefined,
            filter.endpointId
              ? eq(inbound.endpoint, filter.endpointId)
              : undefined,
            filter.afterId ? gt(inbound.id, filter.afterId) : undefined
          )
        )
        .orderBy(
          ...(filter.recent
            ? [desc(inbound.acceptedAt), desc(inbound.id)]
            : [inbound.id])
        )
        .limit(filter.limit)
        .all()
        .map((row) => decodeDurableRecord<InboundRecord>(row.record))
    },
    async listPendingInbound(input) {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 20
      ) {
        throw new TypeError('Invalid pending message limit')
      }

      const rows = db
        .select({ record: inbound.record })
        .from(inbound)
        .innerJoin(
          conversations,
          eq(
            conversations.id,
            jsonValue(inbound.record, '$.snapshot.channel.id')
          )
        )
        .leftJoin(outbound, eq(outbound.id, inbound.finalDeliveryId))
        .where(
          and(
            eq(conversations.active, 1),
            prepared,
            inArray(conversations.id, [...input.channelIds]),
            inArray(inbound.endpoint, [...input.endpointIds]),
            isNull(jsonValue(inbound.record, '$.redactedAt')),
            or(isNull(outbound.status), ne(outbound.status, 'sent')),
            input.cursor
              ? or(
                  gt(inbound.acceptedAt, input.cursor.acceptedAt),
                  and(
                    eq(inbound.acceptedAt, input.cursor.acceptedAt),
                    gt(inbound.id, input.cursor.requestId)
                  )
                )
              : undefined
          )
        )
        .orderBy(inbound.acceptedAt, inbound.id)
        .limit(input.limit)
        .all()

      return rows.map((row) => decodeDurableRecord<InboundRecord>(row.record))
    },
    async listOutbound(filter) {
      return db
        .select({ record: outbound.record })
        .from(outbound)
        .where(
          and(
            filter.deliveryStatus
              ? eq(outbound.status, filter.deliveryStatus)
              : undefined,
            filter.endpointId
              ? eq(
                  jsonValue(outbound.record, '$.endpoint.id'),
                  filter.endpointId
                )
              : undefined,
            filter.afterId ? gt(outbound.id, filter.afterId) : undefined
          )
        )
        .orderBy(outbound.id)
        .limit(filter.limit)
        .all()
        .map((row) => decodeDurableRecord<OutboundRecord>(row.record))
    },
    async getStats() {
      const inboundStats = db
        .select({ pending: count(), oldest: min(inbound.acceptedAt) })
        .from(inbound)
        .where(eq(inbound.status, 'due'))
        .get()

      const undelivered = db
        .select({ count: count() })
        .from(outbound)
        .where(ne(outbound.status, 'sent'))
        .get()

      const unknownDeliveries = db
        .select({ count: count() })
        .from(outbound)
        .where(eq(outbound.status, 'unknown'))
        .get()

      const unknownDispatches = db
        .select({ count: count() })
        .from(inbound)
        .where(eq(jsonValue(inbound.record, '$.dispatch.status'), 'unknown'))
        .get()

      return {
        pending: inboundStats?.pending ?? 0,
        undelivered: undelivered?.count ?? 0,
        unknown:
          (unknownDeliveries?.count ?? 0) + (unknownDispatches?.count ?? 0),
        ...(inboundStats?.oldest !== undefined && inboundStats.oldest !== null
          ? { oldestPendingAt: inboundStats.oldest }
          : {})
      }
    },
    async cleanup(input) {
      return transaction(() => {
        const rows = db
          .select({ record: inbound.record })
          .from(inbound)
          .where(
            and(
              lt(inbound.acceptedAt, input.before),
              inArray(inbound.status, ['accepted', 'rejected']),
              isNull(jsonValue(inbound.record, '$.redactedAt'))
            )
          )
          .orderBy(inbound.acceptedAt, inbound.id)
          .limit(input.limit)
          .all()

        for (const row of rows) {
          const record = decodeDurableRecord<InboundRecord>(row.record)
          saveInbound({
            ...record,
            version: record.version + 1,
            ...(record.preparation ? { preparation: [] } : {}),
            snapshot: {
              ...record.snapshot,
              text: '',
              context: null,
              attachments: []
            },
            redactedAt: input.before
          })
        }

        const deliveries = db
          .select({ record: outbound.record })
          .from(outbound)
          .where(
            and(
              eq(outbound.status, 'sent'),
              lt(
                jsonValue<number>(outbound.record, '$.createdAt'),
                input.before
              ),
              isNull(jsonValue(outbound.record, '$.redactedAt'))
            )
          )
          .limit(input.limit)
          .all()

        for (const row of deliveries) {
          const record = decodeDurableRecord<OutboundRecord>(row.record)
          saveOutbound({
            ...record,
            version: record.version + 1,
            chunks: record.chunks.map((chunk) => ({
              text: '',
              state: null,
              idempotencyKey: chunk.idempotencyKey
            })),
            receipts: record.receipts.map(() => ({})),
            redactedAt: input.before
          })
        }
        const retained = new Set<string>()

        const incoming = db
          .select({ record: inbound.record })
          .from(inbound)
          .where(isNull(jsonValue(inbound.record, '$.redactedAt')))
          .all()

        for (const row of incoming) {
          for (const ref of decodeDurableRecord<InboundRecord>(row.record)
            .snapshot.attachments ?? []) {
            retained.add(ref.id)
            if (ref.previewMediaId) {
              retained.add(ref.previewMediaId)
            }
          }
        }

        const outgoing = db
          .select({ record: outbound.record })
          .from(outbound)
          .where(isNull(jsonValue(outbound.record, '$.redactedAt')))
          .all()

        for (const row of outgoing) {
          for (const chunk of decodeDurableRecord<OutboundRecord>(row.record)
            .chunks) {
            for (const reference of chunkMediaReferences(chunk)) {
              retained.add(reference.id)
              if (reference.previewMediaId) {
                retained.add(reference.previewMediaId)
              }
            }
          }
        }

        const staged = db
          .select({ reference: media.reference })
          .from(media)
          .where(
            and(
              eq(media.staged, 1),
              isNotNull(media.data),
              gte(media.createdAt, input.before)
            )
          )
          .all()

        for (const row of staged) {
          const ref = decodeDurableRecord<MediaReference>(row.reference)
          if (ref.previewMediaId) {
            retained.add(ref.previewMediaId)
          }
        }

        // One bound JSON array avoids SQLite's parameter limit on a large retained media set.
        const retainedIds = db
          .select({ value: sql<string>`value` })
          .from(sql`json_each(${JSON.stringify([...retained])})`)

        const candidates = db
          .select({ id: media.id })
          .from(media)
          .where(
            and(
              isNotNull(media.data),
              lt(media.createdAt, input.before),
              notInArray(media.id, retainedIds)
            )
          )
          .orderBy(media.createdAt, media.id)
          .limit(input.limit)
          .all()

        for (const { id } of candidates) {
          if (!retained.has(id)) {
            db.update(media)
              .set({ data: null, staged: 0 })
              .where(eq(media.id, id))
              .run()
          }
        }
        return { redacted: rows.length + deliveries.length }
      })
    }
  }
}
