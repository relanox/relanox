import type { Storage } from '@relanox/sdk'
import { upgradeRecords } from './upgrade-records.js'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import {
  conversations,
  inbound,
  outbound,
  pluginState,
  media
} from './schema.js'
import type { DatabaseContext } from './database.js'

export function createLifecycle(
  context: Pick<DatabaseContext, 'db' | 'connection'>
): Pick<Storage, 'initialize' | 'health' | 'close'> {
  const { db, connection } = context
  return {
    async initialize() {
      migrate(db, {
        migrationsFolder: fileURLToPath(
          new URL('../migrations', import.meta.url)
        )
      })
      upgradeRecords(db)
    },
    async health() {
      try {
        db.select().from(conversations).limit(0).all()
        db.select().from(inbound).limit(0).all()
        db.select().from(outbound).limit(0).all()
        db.select().from(pluginState).limit(0).all()
        db.select().from(media).limit(0).all()
        return { ok: true }
      } catch {
        return { ok: false, errorCode: 'storage_unavailable' }
      }
    },
    async close() {
      connection.close()
    }
  }
}
