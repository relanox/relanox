import type { Storage } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { boundedLimit } from './database.js'
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  isNotNull,
  lt,
  gte,
  ne,
  notExists,
  or,
  sql
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { conversations, inbound, outbound, media } from './schema.js'

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
      return readInbound(db, id)
    },
    async getOutbound(id) {
      return readOutbound(db, id)
    },
    async listInbound(filter) {
      if (filter.recent && filter.afterId !== undefined) {
        throw new Error('recent_cursor_unsupported')
      }

      const rows = await db
        .select({ record: inbound.record })
        .from(inbound)
        .where(
          and(
            filter.dispatchStatus === undefined
              ? undefined
              : eq(inbound.status, filter.dispatchStatus),
            filter.endpointId === undefined
              ? undefined
              : eq(inbound.endpoint, filter.endpointId),
            filter.afterId === undefined
              ? undefined
              : gt(inbound.id, filter.afterId)
          )
        )
        .orderBy(
          ...(filter.recent
            ? [desc(inbound.acceptedAt), desc(inbound.id)]
            : [inbound.id])
        )
        .limit(boundedLimit(filter.limit))

      return rows.map((row) => row.record)
    },
    async listOutbound(filter) {
      const rows = await db
        .select({ record: outbound.record })
        .from(outbound)
        .where(
          and(
            filter.deliveryStatus === undefined
              ? undefined
              : eq(outbound.status, filter.deliveryStatus),
            filter.endpointId === undefined
              ? undefined
              : eq(
                  sql<string>`${outbound.record}#>>'{endpoint,id}'`,
                  filter.endpointId
                ),
            filter.afterId === undefined
              ? undefined
              : gt(outbound.id, filter.afterId)
          )
        )
        .orderBy(outbound.id)
        .limit(boundedLimit(filter.limit))

      return rows.map((row) => row.record)
    },
    async getStats() {
      const undelivered = db
        .select({ total: count() })
        .from(outbound)
        .where(ne(outbound.status, 'sent'))

      const unknownOutbound = db
        .select({ total: count() })
        .from(outbound)
        .where(eq(outbound.status, 'unknown'))

      const row = (
        await db
          .select({
            pending:
              sql<number>`count(*) filter (where ${inbound.status}='due')`.mapWith(
                Number
              ),
            oldest: sql<
              number | null
            >`min(${inbound.acceptedAt}) filter (where ${inbound.status}='due')`.mapWith(
              (value) => (value === null ? null : Number(value))
            ),
            undelivered: sql<number>`(${undelivered})`.mapWith(Number),
            unknown:
              sql<number>`count(*) filter (where ${inbound.record}#>>'{dispatch,status}'='unknown') + (${unknownOutbound})`.mapWith(
                Number
              )
          })
          .from(inbound)
      )[0]

      if (!row) {
        throw new Error('Storage aggregates unavailable')
      }
      return {
        pending: row.pending,
        undelivered: row.undelivered,
        unknown: row.unknown,
        ...(row.oldest === null ? {} : { oldestPendingAt: row.oldest })
      }
    },
    async cleanup(input) {
      return transaction(async (client) => {
        // Media writers lock their conversation before publishing references.
        await client
          .select({ id: conversations.id })
          .from(conversations)
          .orderBy(conversations.id)
          .for('update')

        const rows = await client
          .select({ record: inbound.record })
          .from(inbound)
          .where(
            and(
              lt(inbound.acceptedAt, input.before),
              inArray(inbound.status, ['accepted', 'rejected']),
              isNull(sql`${inbound.record}->'redactedAt'`)
            )
          )
          .orderBy(inbound.acceptedAt, inbound.id)
          .limit(boundedLimit(input.limit))
          .for('update')

        for (const { record } of rows) {
          await saveInbound(client, {
            ...record,
            version: record.version + 1,
            snapshot: {
              ...record.snapshot,
              text: '',
              context: null,
              attachments: []
            },
            redactedAt: input.before
          })
        }

        const deliveries = await client
          .select({ record: outbound.record })
          .from(outbound)
          .where(
            and(
              eq(outbound.status, 'sent'),
              lt(
                sql<number>`(${outbound.record}->>'createdAt')::bigint`,
                input.before
              ),
              isNull(sql`${outbound.record}->'redactedAt'`)
            )
          )
          .limit(boundedLimit(input.limit))
          .for('update')

        for (const { record } of deliveries) {
          await saveOutbound(client, {
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
        // Keep reference existence checks in SQL so cleanup never materializes all retained messages.
        const staged = alias(media, 'staged_preview_owner')

        const referencedIncoming = client
          .select({ id: inbound.id })
          .from(inbound)
          .where(
            and(
              isNull(sql`${inbound.record}->'redactedAt'`),
              sql`jsonb_path_exists(${inbound.record}, '$.snapshot.attachments[*] ? (@.id == $id || @.previewMediaId == $id)', jsonb_build_object('id', ${media.id}))`
            )
          )

        const referencedOutgoing = client
          .select({ id: outbound.id })
          .from(outbound)
          .where(
            and(
              isNull(sql`${outbound.record}->'redactedAt'`),
              or(
                sql`jsonb_path_exists(${outbound.record}, '$.chunks[*].media ? (@.id == $id || @.previewMediaId == $id)', jsonb_build_object('id', ${media.id}))`,
                sql`jsonb_path_exists(${outbound.record}, '$.chunks[*].richText[*] ? (@.type == "image" && (@.media.id == $id || @.media.previewMediaId == $id))', jsonb_build_object('id', ${media.id}))`
              )
            )
          )

        const referencedStaged = client
          .select({ id: staged.id })
          .from(staged)
          .where(
            and(
              eq(staged.staged, true),
              isNotNull(staged.data),
              gte(staged.createdAt, input.before),
              eq(sql<string>`${staged.reference}->>'previewMediaId'`, media.id)
            )
          )

        const candidates = await client
          .select({ id: media.id })
          .from(media)
          .where(
            and(
              isNotNull(media.data),
              lt(media.createdAt, input.before),
              notExists(referencedIncoming),
              notExists(referencedOutgoing),
              notExists(referencedStaged)
            )
          )
          .orderBy(media.createdAt, media.id)
          .limit(boundedLimit(input.limit))
          .for('update')

        await client
          .update(media)
          .set({ data: null, staged: false })
          .where(
            inArray(
              media.id,
              candidates.map((candidate) => candidate.id)
            )
          )
        return { redacted: rows.length + deliveries.length }
      })
    }
  }
}
