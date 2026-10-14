import type { Storage } from '@relanox/sdk'
import { upgradeRecords } from './upgrade-records.js'
import type { DatabaseContext } from './database.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { fileURLToPath } from 'node:url'
import { schema as tables } from './schema.js'

export function createLifecycle(
  context: Pick<DatabaseContext, 'config' | 'pool' | 'db'>
): Pick<Storage, 'initialize' | 'health' | 'close'> {
  const { config, pool, db } = context
  return {
    async initialize() {
      const client = await pool.connect()
      const migrationDb = drizzle(client)
      const lock = `relanox:initialize:${config.schema}`
      let discard = false
      try {
        // Session locking keeps the exported ORM migrator's transaction on this same connection.
        await migrationDb.execute(
          sql`select pg_advisory_lock(hashtextextended(${lock}, 0))`
        )
        await migrate(migrationDb, {
          migrationsFolder: fileURLToPath(
            new URL('../migrations', import.meta.url)
          ),
          migrationsSchema: config.schema
        })
        await upgradeRecords(migrationDb)
      } catch (error) {
        discard = true
        throw error
      } finally {
        try {
          await migrationDb.execute(
            sql`select pg_advisory_unlock(hashtextextended(${lock}, 0))`
          )
        } catch {
          discard = true
        }
        client.release(discard)
      }
    },
    async health() {
      try {
        await db.select().from(tables.conversations).limit(0)
        await db
          .select({ id: tables.inbound.id, record: tables.inbound.record })
          .from(tables.inbound)
          .limit(0)
        await db
          .select({ id: tables.outbound.id, record: tables.outbound.record })
          .from(tables.outbound)
          .limit(0)
        await db
          .select({
            plugin: tables.pluginState.plugin,
            owner: tables.pluginState.owner,
            key: tables.pluginState.key,
            version: tables.pluginState.version,
            record: tables.pluginState.record
          })
          .from(tables.pluginState)
          .limit(0)
        await db
          .select({
            id: tables.media.id,
            reference: tables.media.reference,
            data: tables.media.data
          })
          .from(tables.media)
          .limit(0)
        return { ok: true }
      } catch {
        return { ok: false, errorCode: 'storage_unavailable' }
      }
    },
    async close() {
      await pool.end()
    }
  }
}
