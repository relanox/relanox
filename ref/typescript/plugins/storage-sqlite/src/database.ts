import { decodeDurableRecord } from './record-codec.js'
import type {
  InboundRecord,
  OutboundRecord,
  ConversationRecord
} from '@relanox/sdk'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, eq } from 'drizzle-orm'
import type { SqliteConfig } from './config.js'
import { encodeDurableRecord } from '@relanox/storage-support'
import { conversations, inbound, outbound } from './schema.js'

/** Owns the connection and atomic transaction boundary for every storage operation. */
export function openDatabase(config: SqliteConfig): DatabaseContext {
  const connection = new Database(config.filename)
  connection.pragma('busy_timeout = 5000')
  connection.pragma('journal_mode = WAL')
  connection.pragma('foreign_keys = ON')
  const db = drizzle(connection)

  const transaction = <T>(fn: () => T): T =>
    db.transaction(fn, { behavior: 'immediate' })

  const readInbound = (id: string): InboundRecord | undefined => {
    const row = db
      .select({ record: inbound.record })
      .from(inbound)
      .where(eq(inbound.id, id))
      .get()

    return row ? decodeDurableRecord(row.record) : undefined
  }

  const readOutbound = (id: string): OutboundRecord | undefined => {
    const row = db
      .select({ record: outbound.record })
      .from(outbound)
      .where(eq(outbound.id, id))
      .get()

    return row ? decodeDurableRecord(row.record) : undefined
  }

  const readConversation = (
    id: string,
    includeInactive = false
  ): ConversationRecord | undefined => {
    const row = db
      .select({ record: conversations.record })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, id),
          includeInactive ? undefined : eq(conversations.active, 1)
        )
      )
      .get()

    return row ? decodeDurableRecord(row.record) : undefined
  }

  const saveInbound = (record: InboundRecord): Database.RunResult =>
    db
      .update(inbound)
      .set({
        finalDeliveryId: record.reply?.finalDeliveryId ?? null,
        status: record.dispatch.status,
        version: record.version,
        record: encodeDurableRecord(record)
      })
      .where(eq(inbound.id, record.snapshot.requestId))
      .run()

  const saveOutbound = (record: OutboundRecord): Database.RunResult =>
    db
      .update(outbound)
      .set({
        status: record.status,
        version: record.version,
        record: encodeDurableRecord(record)
      })
      .where(eq(outbound.id, record.deliveryId))
      .run()

  return {
    db,
    connection,
    transaction,
    readInbound,
    readConversation,
    readOutbound,
    saveInbound,
    saveOutbound
  }
}

export type DatabaseContext = {
  db: BetterSQLite3Database
  connection: Database.Database
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

export const boundedLimit = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('Invalid storage limit')
  }
  return Math.min(limit, 1000)
}
