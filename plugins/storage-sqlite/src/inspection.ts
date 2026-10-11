import { decodeDurableRecord } from './record-codec.js'
import type { Storage, InboundRecord, OutboundRecord } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'

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
      return readInbound(id)
    },
    async getOutbound(id) {
      return readOutbound(id)
    },
    async listInbound(filter) {
      const where = ['1=1']
      const params: (string | number)[] = []
      if (filter.dispatchStatus) {
        where.push('status=?')
        params.push(filter.dispatchStatus)
      }
      if (filter.endpointId) {
        where.push('endpoint=?')
        params.push(filter.endpointId)
      }
      if (filter.afterId) {
        where.push('id>?')
        params.push(filter.afterId)
      }
      return (
        db
          .prepare(
            `SELECT record FROM inbound WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`
          )
          .all(...params, filter.limit) as { record: string }[]
      ).map((row) => decodeDurableRecord<InboundRecord>(row.record))
    },
    async listOutbound(filter) {
      const where = ['1=1']
      const params: (string | number)[] = []
      if (filter.deliveryStatus) {
        where.push('outbound_delivery.status=?')
        params.push(filter.deliveryStatus)
      }
      if (filter.endpointId) {
        where.push('inbound_request.endpoint=?')
        params.push(filter.endpointId)
      }
      if (filter.afterId) {
        where.push('outbound_delivery.id>?')
        params.push(filter.afterId)
      }
      return (
        db
          .prepare(
            `
              SELECT outbound_delivery.record
              FROM outbound outbound_delivery
              JOIN inbound inbound_request ON inbound_request.id=outbound_delivery.request_id
              WHERE ${where.join(' AND ')}
              ORDER BY outbound_delivery.id
              LIMIT ?
            `
          )
          .all(...params, filter.limit) as { record: string }[]
      ).map((row) => decodeDurableRecord<OutboundRecord>(row.record))
    },
    async getStats() {
      const inboundStats = db
        .prepare(
          `
            SELECT
              SUM(status='due') pending,
              MIN(CASE WHEN status='due' THEN accepted_at END) oldest
            FROM inbound
          `
        )
        .get() as {
        pending: number | null
        oldest: number | null
      }

      const outboundStats = db
        .prepare(
          "SELECT SUM(status!='sent') undelivered,SUM(status='unknown') unknown FROM outbound"
        )
        .get() as { undelivered: number | null; unknown: number | null }

      const unknownDispatches = db
        .prepare(
          `
            SELECT COUNT(*) count
            FROM inbound
            WHERE json_extract(record,'$.dispatch.status')='unknown'
          `
        )
        .get() as { count: number }

      return {
        pending: inboundStats.pending ?? 0,
        undelivered: outboundStats.undelivered ?? 0,
        unknown: (outboundStats.unknown ?? 0) + unknownDispatches.count,
        ...(inboundStats.oldest !== null
          ? { oldestPendingAt: inboundStats.oldest }
          : {})
      }
    },
    async cleanup(input) {
      return transaction(() => {
        const rows = db
          .prepare(
            `SELECT i.record FROM inbound i WHERE i.accepted_at<? AND i.status IN ('accepted','rejected') AND json_extract(i.record,'$.redactedAt') IS NULL AND NOT EXISTS(SELECT 1 FROM outbound o WHERE o.request_id=i.id AND (o.status!='sent' OR json_extract(o.record,'$.createdAt')>=?)) ORDER BY i.accepted_at,i.id LIMIT ?`
          )
          .all(input.before, input.before, input.limit) as { record: string }[]

        for (const row of rows) {
          const record = decodeDurableRecord<InboundRecord>(row.record)
          saveInbound({
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
          db.prepare('UPDATE media SET data=NULL WHERE request_id=?').run(
            record.snapshot.requestId
          )

          const deliveries = db
            .prepare('SELECT record FROM outbound WHERE request_id=?')
            .all(record.snapshot.requestId) as { record: string }[]

          for (const deliveryRow of deliveries) {
            const delivery = decodeDurableRecord<OutboundRecord>(
              deliveryRow.record
            )

            saveOutbound({
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
