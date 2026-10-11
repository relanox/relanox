import type { InboundRecord, OutboundRecord } from '@relanox/sdk'
import Database from 'better-sqlite3'
import type { SqliteConfig } from './config.js'
import { encodeDurableRecord, decodeDurableRecord } from './record-codec.js'

/** Owns the connection and atomic transaction boundary for every storage operation. */
export function openDatabase(config: SqliteConfig): DatabaseContext {
  const db = new Database(config.filename)
  db.pragma(`busy_timeout = ${config.busyTimeoutMs}`)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const transaction = <T>(fn: () => T): T => db.transaction(fn).immediate()

  const readInbound = (id: string): InboundRecord | undefined => {
    const row = db.prepare('SELECT record FROM inbound WHERE id=?').get(id) as
      { record: string } | undefined

    return row ? decodeDurableRecord(row.record) : undefined
  }

  const readOutbound = (id: string): OutboundRecord | undefined => {
    const row = db.prepare('SELECT record FROM outbound WHERE id=?').get(id) as
      { record: string } | undefined

    return row ? decodeDurableRecord(row.record) : undefined
  }

  const saveInbound = (record: InboundRecord) =>
    db
      .prepare('UPDATE inbound SET status=?, version=?, record=? WHERE id=?')
      .run(
        record.status,
        record.version,
        encodeDurableRecord(record),
        record.snapshot.requestId
      )

  const saveOutbound = (record: OutboundRecord) =>
    db
      .prepare('UPDATE outbound SET status=?, version=?, record=? WHERE id=?')
      .run(
        record.status,
        record.version,
        encodeDurableRecord(record),
        record.deliveryId
      )

  const isEndpointHead = (record: InboundRecord): boolean =>
    (
      db
        .prepare(
          `
            SELECT id
            FROM inbound
            WHERE endpoint=?
              AND status IN ('pending','claimed')
            ORDER BY CASE
              WHEN status='claimed' THEN 0
              WHEN json_extract(record,'$.dispatch.lease') IS NOT NULL
              OR json_extract(record,'$.dispatch.attempts')>0
              OR json_extract(record,'$.dispatch.status') IN ('unknown','rejected') THEN 1
              ELSE 2 END,accepted_at,id
            LIMIT 1
          `
        )
        .get(record.snapshot.endpoint.id) as { id: string } | undefined
    )?.id === record.snapshot.requestId

  return {
    db,
    transaction,
    readInbound,
    readOutbound,
    saveInbound,
    saveOutbound,
    isEndpointHead
  }
}

export interface DatabaseContext {
  db: Database.Database
  transaction<T>(this: void, fn: () => T): T
  readInbound(this: void, id: string): InboundRecord | undefined
  readOutbound(this: void, id: string): OutboundRecord | undefined
  saveInbound(this: void, record: InboundRecord): Database.RunResult
  saveOutbound(this: void, record: OutboundRecord): Database.RunResult
  isEndpointHead(this: void, record: InboundRecord): boolean
}
