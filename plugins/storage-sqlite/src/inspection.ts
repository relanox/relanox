import { decodeDurableRecord } from './record-codec.js'
import type {
  Storage,
  InboundRecord,
  OutboundRecord,
  MediaReference
} from '@relanox/sdk'
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
        where.push("json_extract(outbound_delivery.record,'$.endpoint.id')=?")
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
            "SELECT record FROM inbound WHERE accepted_at<? AND status IN ('accepted','rejected') AND json_extract(record,'$.redactedAt') IS NULL ORDER BY accepted_at,id LIMIT ?"
          )
          .all(input.before, input.limit) as { record: string }[]

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
        }

        const deliveries = db
          .prepare(
            "SELECT record FROM outbound WHERE status='sent' AND json_extract(record,'$.createdAt')<? AND json_extract(record,'$.redactedAt') IS NULL LIMIT ?"
          )
          .all(input.before, input.limit) as { record: string }[]

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
          .prepare(
            "SELECT record FROM inbound WHERE json_extract(record,'$.redactedAt') IS NULL"
          )
          .all() as { record: string }[]

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
          .prepare(
            "SELECT record FROM outbound WHERE json_extract(record,'$.redactedAt') IS NULL"
          )
          .all() as { record: string }[]

        for (const row of outgoing) {
          for (const chunk of decodeDurableRecord<OutboundRecord>(row.record)
            .chunks) {
            if (chunk.media) {
              retained.add(chunk.media.id)
              if (chunk.media.previewMediaId) {
                retained.add(chunk.media.previewMediaId)
              }
            }
          }
        }

        const staged = db
          .prepare(
            'SELECT reference FROM media WHERE staged=1 AND data IS NOT NULL AND created_at>=?'
          )
          .all(input.before) as { reference: string }[]

        for (const row of staged) {
          const ref = decodeDurableRecord<MediaReference>(row.reference)
          if (ref.previewMediaId) {
            retained.add(ref.previewMediaId)
          }
        }

        const candidates = db
          .prepare(
            'SELECT id FROM media WHERE data IS NOT NULL AND created_at<? AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at,id LIMIT ?'
          )
          .all(input.before, JSON.stringify([...retained]), input.limit) as {
          id: string
        }[]

        for (const { id } of candidates) {
          if (!retained.has(id)) {
            db.prepare('UPDATE media SET data=NULL,staged=0 WHERE id=?').run(id)
          }
        }
        return { redacted: rows.length + deliveries.length }
      })
    }
  }
}
