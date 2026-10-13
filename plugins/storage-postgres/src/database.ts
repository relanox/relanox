import type {
  InboundRecord,
  ConversationRecord,
  OutboundRecord,
  Observability,
  Span
} from '@relanox/sdk'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, eq, or, sql } from 'drizzle-orm'
import { schema as tables } from './schema.js'
import { encodeDurableRecord } from '@relanox/storage-support'
import type { z } from 'zod'
import type { PostgresConfig } from './config.js'
import { configSchema } from './config.js'

/** Owns the connection and atomic transaction boundary for every storage operation. */
export function openDatabase(
  configuration: z.input<typeof configSchema>,
  observe: Observability
): DatabaseContext {
  const config = configSchema.parse(configuration)
  const connectionString = process.env[config.connectionString.env]
  if (!connectionString) {
    throw new Error('PostgreSQL connection secret is unavailable')
  }

  const pool = new Pool({
    connectionString,
    max: config.maxConnections,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    options: `-c search_path=${config.schema} -c idle_in_transaction_session_timeout=10000`
  })

  // An idle socket failure must not become an unhandled EventEmitter error.
  pool.on('error', () => {
    try {
      observe.log('error', 'storage.failed', {
        plugin: 'storage-postgres',
        errorCode: 'unavailable'
      })
    } catch {
      /* Telemetry is best effort */
    }
  })

  const db = drizzle(pool, { schema: tables })

  const transaction = async <T>(
    fn: (client: Database) => Promise<T>
  ): Promise<T> => {
    const started = performance.now()
    let span: Span | undefined
    try {
      span = observe.span('storage', {
        plugin: 'storage-postgres',
        operation: 'storage'
      })
    } catch {
      /* Telemetry is best effort */
    }
    let outcome: 'ok' | 'error' = 'error'
    try {
      for (let attempt = 0; ; attempt++) {
        const client = await pool.connect()
        let discard = false
        try {
          const result = await drizzle(client, { schema: tables }).transaction(
            fn,
            {
              isolationLevel: 'serializable'
            }
          )

          outcome = 'ok'
          return result
        } catch (error) {
          // Own checkout release even if the ORM fails before entering its transaction body.
          discard = true
          if (
            attempt < 7 &&
            ['40001', '40P01'].includes(databaseErrorCode(error) ?? '')
          ) {
            continue
          }
          throw error
        } finally {
          client.release(discard)
        }
      }
    } finally {
      try {
        span?.end(outcome)
      } catch {
        /* Telemetry is best effort */
      }
      try {
        observe.record(
          'relanox_storage_duration_seconds',
          (performance.now() - started) / 1000,
          {
            plugin: 'storage-postgres',
            operation: 'storage',
            outcome
          }
        )
      } catch {
        /* Telemetry is best effort */
      }
    }
  }

  const readInbound = async (
    client: Database,
    id: string
  ): Promise<InboundRecord | undefined> =>
    (
      await client
        .select({ record: tables.inbound.record })
        .from(tables.inbound)
        .where(eq(tables.inbound.id, id))
        .for('update')
    )[0]?.record

  const readOutbound = async (
    client: Database,
    id: string
  ): Promise<OutboundRecord | undefined> =>
    (
      await client
        .select({ record: tables.outbound.record })
        .from(tables.outbound)
        .where(eq(tables.outbound.id, id))
    )[0]?.record

  const readConversation = async (
    client: Database,
    id: string,
    includeInactive = false
  ): Promise<ConversationRecord | undefined> =>
    (
      await client
        .select({ record: tables.conversations.record })
        .from(tables.conversations)
        .where(
          and(
            eq(tables.conversations.id, id),
            or(eq(tables.conversations.active, true), sql`${includeInactive}`)
          )
        )
        .for('update')
    )[0]?.record

  const saveInbound = async (
    client: Database,
    record: InboundRecord,
    expectedVersion = record.version - 1
  ): Promise<void> => {
    const changed = await client
      .update(tables.inbound)
      .set({
        finalDeliveryId: record.reply?.finalDeliveryId ?? null,
        status: record.dispatch.status,
        version: record.version,
        record: durable(record)
      })
      .where(
        and(
          eq(tables.inbound.id, record.snapshot.requestId),
          eq(tables.inbound.version, expectedVersion)
        )
      )
      .returning({ id: tables.inbound.id })

    if (changed.length !== 1) {
      throw new Error('Inbound version conflict')
    }
  }

  const saveOutbound = async (
    client: Database,
    record: OutboundRecord,
    expectedVersion = record.version - 1
  ): Promise<void> => {
    const changed = await client
      .update(tables.outbound)
      .set({
        status: record.status,
        version: record.version,
        record: durable(record)
      })
      .where(
        and(
          eq(tables.outbound.id, record.deliveryId),
          eq(tables.outbound.version, expectedVersion)
        )
      )
      .returning({ id: tables.outbound.id })

    if (changed.length !== 1) {
      throw new Error('Outbound version conflict')
    }
  }

  return {
    config,
    pool,
    db,
    transaction,
    readInbound,
    readConversation,
    readOutbound,
    saveInbound,
    saveOutbound
  }
}

export type Database = NodePgDatabase<typeof tables>

export type DatabaseContext = {
  readonly config: PostgresConfig
  readonly pool: Pool
  readonly db: Database
  transaction<T>(
    this: void,
    operation: (client: Database) => Promise<T>
  ): Promise<T>
  readConversation(
    this: void,
    client: Database,
    id: string,
    includeInactive?: boolean
  ): Promise<ConversationRecord | undefined>
  readInbound(
    this: void,
    client: Database,
    id: string
  ): Promise<InboundRecord | undefined>
  readOutbound(
    this: void,
    client: Database,
    id: string
  ): Promise<OutboundRecord | undefined>
  saveInbound(
    this: void,
    client: Database,
    record: InboundRecord,
    expectedVersion?: number
  ): Promise<void>
  saveOutbound(
    this: void,
    client: Database,
    record: OutboundRecord,
    expectedVersion?: number
  ): Promise<void>
}

function databaseErrorCode(error: unknown): string | undefined {
  const seen = new Set<object>()
  let current = error
  while (
    current !== null &&
    typeof current === 'object' &&
    !seen.has(current)
  ) {
    seen.add(current)
    if ('code' in current && typeof current.code === 'string') {
      return current.code
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}

export const boundedLimit = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('Invalid storage limit')
  }
  return Math.min(limit, 1000)
}

/** Validate before Drizzle JSONB serialization, retaining the durable plain-JSON boundary. */
export function durable<T>(value: T): T {
  return JSON.parse(encodeDurableRecord(value)) as T
}
