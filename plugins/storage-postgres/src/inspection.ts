import type { Storage, InboundRecord, OutboundRecord } from '@relanox/sdk'
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
            ORDER BY id
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
        where.push(`inbound_request.endpoint=$${params.length}`)
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
            JOIN inbound inbound_request ON inbound_request.id=outbound_delivery.request_id
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
        const rows = await query<{ record: InboundRecord }>(
          client,
          `SELECT i.record FROM inbound i WHERE i.accepted_at<$1 AND i.status IN ('accepted','rejected') AND i.record->'redactedAt' IS NULL AND NOT EXISTS(SELECT 1 FROM outbound o WHERE o.request_id=i.id AND (o.status!='sent' OR (o.record->>'createdAt')::bigint>=$1)) ORDER BY i.accepted_at,i.id LIMIT $2 FOR UPDATE`,
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
          await client.query('UPDATE media SET data=NULL WHERE request_id=$1', [
            record.snapshot.requestId
          ])

          const deliveries = await query<{ record: OutboundRecord }>(
            client,
            'SELECT record FROM outbound WHERE request_id=$1',
            [record.snapshot.requestId]
          )

          for (const { record: delivery } of deliveries) {
            await saveOutbound(client, {
              ...delivery,
              version: delivery.version + 1,
              chunks: delivery.chunks.map((chunk) => ({
                text: '',
                state: null,
                idempotencyKey: chunk.idempotencyKey
              })),
              receipts: delivery.receipts.map(() => ({}))
            })
          }
        }
        return { redacted: rows.length }
      })
    }
  }
}
