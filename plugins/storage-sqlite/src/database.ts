import { decodeDurableRecord } from './record-codec.js'
import type {
  InboundRecord,
  OutboundRecord,
  ConversationRecord
} from '@relanox/sdk'
import Database from 'better-sqlite3'
import type { SqliteConfig } from './config.js'
import { encodeDurableRecord } from '@relanox/storage-support'

/** Owns the connection and atomic transaction boundary for every storage operation. */
export function openDatabase(config: SqliteConfig): DatabaseContext {
  const db = new Database(config.filename)
  db.pragma('busy_timeout = 5000')
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

  const readConversation = (
    id: string,
    includeInactive = false
  ): ConversationRecord | undefined => {
    const row = db
      .prepare(
        'SELECT record FROM conversations WHERE id=? AND (active=1 OR ?=1)'
      )
      .get(id, includeInactive ? 1 : 0) as { record: string } | undefined

    return row ? decodeDurableRecord(row.record) : undefined
  }

  const saveInbound = (record: InboundRecord): Database.RunResult =>
    db
      .prepare('UPDATE inbound SET status=?, version=?, record=? WHERE id=?')
      .run(
        record.dispatch.status,
        record.version,
        encodeDurableRecord(record),
        record.snapshot.requestId
      )

  const saveOutbound = (record: OutboundRecord): Database.RunResult =>
    db
      .prepare('UPDATE outbound SET status=?, version=?, record=? WHERE id=?')
      .run(
        record.status,
        record.version,
        encodeDurableRecord(record),
        record.deliveryId
      )

  return {
    db,
    transaction,
    readInbound,
    readConversation,
    readOutbound,
    saveInbound,
    saveOutbound
  }
}

export type DatabaseContext = {
  db: Database.Database
  transaction<T>(this: void, fn: () => T): T
  readConversation(
    this: void,
    id: string,
    includeInactive?: boolean
  ): ConversationRecord | undefined
  readInbound(this: void, id: string): InboundRecord | undefined
  readOutbound(this: void, id: string): OutboundRecord | undefined
  saveInbound(this: void, record: InboundRecord): Database.RunResult
  saveOutbound(this: void, record: OutboundRecord): Database.RunResult
}
