import type { Storage } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'

export function createLifecycle(
  context: Pick<DatabaseContext, 'db' | 'transaction'>
): Pick<Storage, 'initialize' | 'health' | 'close'> {
  const { db, transaction } = context
  return {
    async initialize() {
      transaction(() => {
        db.exec(
          `
          CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, active INTEGER NOT NULL, record TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS inbound(
            id TEXT PRIMARY KEY, channel TEXT NOT NULL, account TEXT NOT NULL,
            event TEXT NOT NULL, endpoint TEXT NOT NULL, accepted_at INTEGER NOT NULL,
            status TEXT NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(channel,account,event));
          CREATE INDEX IF NOT EXISTS inbound_fifo ON inbound(endpoint,accepted_at,id);
          CREATE TABLE IF NOT EXISTS outbound(
            id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES conversations(id),
            message_id TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL,
            version INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(channel_id,message_id));
          CREATE INDEX IF NOT EXISTS outbound_channel_order ON outbound(channel_id) WHERE status IN ('pending','unknown');
          CREATE TABLE IF NOT EXISTS media(
            id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES conversations(id),
            reference TEXT NOT NULL, data BLOB, digest TEXT NOT NULL, staged INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS media_channel ON media(channel_id);
          CREATE TABLE IF NOT EXISTS plugin_state(
            plugin TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
            version INTEGER NOT NULL, expires_at INTEGER, record TEXT NOT NULL,
            PRIMARY KEY(plugin,owner,key));
        `
        )
      })
    },
    async health() {
      try {
        db.prepare(
          'SELECT id,endpoint,active,record FROM conversations LIMIT 0'
        ).all()
        db.prepare('SELECT id,record FROM inbound LIMIT 0').all()
        db.prepare('SELECT id,record FROM outbound LIMIT 0').all()
        db.prepare(
          'SELECT plugin,owner,key,version,record FROM plugin_state LIMIT 0'
        ).all()
        db.prepare('SELECT id,reference,data FROM media LIMIT 0').all()
        return { ok: true }
      } catch {
        return { ok: false, errorCode: 'storage_unavailable' }
      }
    },
    async close() {
      db.close()
    }
  }
}
