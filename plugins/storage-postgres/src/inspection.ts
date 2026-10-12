import { chunkMediaReferences } from '@relanox/storage-support'
import type {
  Storage,
  InboundRecord,
  OutboundRecord,
  MediaReference
} from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { boundedLimit } from './database.js'

export function createInspectionOperations(
  context: Pick<
    DatabaseContext,
    | 'pool'
    | 'query'
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
    pool,
    query,
    transaction,
    readInbound,
    readOutbound,
    saveInbound,
    saveOutbound
  } = context

  return {
    async getInbound(id) {
      return readInbound(pool, id)
    },
    async getOutbound(id) {
      return readOutbound(pool, id)
    },
    async listInbound(filter) {
      if (filter.recent && filter.afterId !== undefined) {
        throw new Error('recent_cursor_unsupported')
      }
      const order = filter.recent ? 'accepted_at DESC,id DESC' : 'id'
      const where = ['1=1']
      const params: unknown[] = []
      if (filter.dispatchStatus !== undefined) {
        params.push(filter.dispatchStatus)
        where.push(`status=$${params.length}`)
      }
      if (filter.endpointId !== undefined) {
        params.push(filter.endpointId)
        where.push(`endpoint=$${params.length}`)
      }
      if (filter.afterId !== undefined) {
        params.push(filter.afterId)
        where.push(`id>$${params.length}`)
      }
      params.push(boundedLimit(filter.limit))
      return (
        await query<{ record: InboundRecord }>(
          pool,
          `
            SELECT record
            FROM inbound
            WHERE ${where.join(' AND ')}
            ORDER BY ${order}
            LIMIT $${params.length}
          `,
          params
        )
      ).map((record) => record.record)
    },
    async listOutbound(filter) {
      const where = ['1=1']
      const params: unknown[] = []
      if (filter.deliveryStatus !== undefined) {
        params.push(filter.deliveryStatus)
        where.push(`outbound_delivery.status=$${params.length}`)
      }
      if (filter.endpointId !== undefined) {
        params.push(filter.endpointId)
        where.push(
          `outbound_delivery.record#>>'{endpoint,id}'=$${params.length}`
        )
      }
      if (filter.afterId !== undefined) {
        params.push(filter.afterId)
        where.push(`outbound_delivery.id>$${params.length}`)
      }
      params.push(boundedLimit(filter.limit))
      return (
        await query<{ record: OutboundRecord }>(
          pool,
          `
            SELECT outbound_delivery.record
            FROM outbound outbound_delivery
            WHERE ${where.join(' AND ')}
            ORDER BY outbound_delivery.id
            LIMIT $${params.length}
          `,
          params
        )
      ).map((record) => record.record)
    },
    async getStats() {
      const row = (
        await query<{
          pending: string
          oldest: string | null
          undelivered: string
          unknown: string
        }>(
          pool,
          `
            SELECT
              COUNT(*) FILTER(WHERE status='due') pending,
              MIN(accepted_at) FILTER(WHERE status='due') oldest,
              (SELECT COUNT(*) FROM outbound WHERE status!='sent') undelivered,
              COUNT(*) FILTER(
                WHERE record#>>'{dispatch,status}'='unknown'
              ) + (SELECT COUNT(*) FROM outbound WHERE status='unknown') unknown
            FROM inbound
          `
        )
      )[0]

      if (!row) {
        throw new Error('Storage aggregates unavailable')
      }
      return {
        pending: Number(row.pending),
        undelivered: Number(row.undelivered),
        unknown: Number(row.unknown),
        ...(row.oldest !== null ? { oldestPendingAt: Number(row.oldest) } : {})
      }
    },
    async cleanup(input) {
      return transaction(async (client) => {
        // Media writers lock their conversation before publishing references.
        await client.query(
          'SELECT id FROM conversations ORDER BY id FOR UPDATE'
        )

        const rows = await query<{ record: InboundRecord }>(
          client,
          "SELECT record FROM inbound WHERE accepted_at<$1 AND status IN ('accepted','rejected') AND record->'redactedAt' IS NULL ORDER BY accepted_at,id LIMIT $2 FOR UPDATE",
          [input.before, boundedLimit(input.limit)]
        )

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

        const deliveries = await query<{ record: OutboundRecord }>(
          client,
          "SELECT record FROM outbound WHERE status='sent' AND (record->>'createdAt')::bigint<$1 AND record->'redactedAt' IS NULL LIMIT $2 FOR UPDATE",
          [input.before, boundedLimit(input.limit)]
        )

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
        const retained = new Set<string>()

        const incoming = await query<{ record: InboundRecord }>(
          client,
          "SELECT record FROM inbound WHERE record->'redactedAt' IS NULL"
        )

        for (const { record } of incoming) {
          for (const ref of record.snapshot.attachments ?? []) {
            retained.add(ref.id)
            if (ref.previewMediaId) {
              retained.add(ref.previewMediaId)
            }
          }
        }

        const outgoing = await query<{ record: OutboundRecord }>(
          client,
          "SELECT record FROM outbound WHERE record->'redactedAt' IS NULL"
        )

        for (const { record } of outgoing) {
          for (const chunk of record.chunks) {
            for (const reference of chunkMediaReferences(chunk)) {
              retained.add(reference.id)
              if (reference.previewMediaId) {
                retained.add(reference.previewMediaId)
              }
            }
          }
        }

        const staged = await query<{ reference: MediaReference }>(
          client,
          'SELECT reference FROM media WHERE staged=TRUE AND data IS NOT NULL AND created_at>=$1',
          [input.before]
        )

        for (const { reference } of staged) {
          if (reference.previewMediaId) {
            retained.add(reference.previewMediaId)
          }
        }

        const candidates = await query<{ id: string }>(
          client,
          'SELECT id FROM media WHERE data IS NOT NULL AND created_at<$1 AND NOT(id=ANY($2::text[])) ORDER BY created_at,id LIMIT $3 FOR UPDATE',
          [input.before, [...retained], boundedLimit(input.limit)]
        )

        for (const { id } of candidates) {
          if (!retained.has(id)) {
            await client.query(
              'UPDATE media SET data=NULL,staged=FALSE WHERE id=$1',
              [id]
            )
          }
        }
        return { redacted: rows.length + deliveries.length }
      })
    }
  }
}
