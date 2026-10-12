import type { Storage } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'

export function createLifecycle(
  context: Pick<DatabaseContext, 'config' | 'pool' | 'transaction'>
): Pick<Storage, 'initialize' | 'health' | 'close'> {
  const { config, pool, transaction } = context
  return {
    async initialize() {
      await transaction(async (client) => {
        // Serialize concurrent startup; schema is a validated PostgreSQL identifier.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`relanox:initialize:${config.schema}`]
        )
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`)

        await client.query(`
          CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, active BOOLEAN NOT NULL, record JSONB NOT NULL);
          CREATE TABLE IF NOT EXISTS inbound(
            id TEXT COLLATE "C" PRIMARY KEY, channel TEXT NOT NULL, account TEXT NOT NULL,event TEXT NOT NULL,
            endpoint TEXT NOT NULL,accepted_at BIGINT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,record JSONB NOT NULL,UNIQUE(channel,account,event));
          CREATE INDEX IF NOT EXISTS inbound_fifo ON inbound(endpoint,accepted_at,id) WHERE status='due';
          CREATE INDEX IF NOT EXISTS inbound_due ON inbound(((record#>>'{dispatch,dueAt}')::bigint),accepted_at,id) WHERE status='due';
          CREATE INDEX IF NOT EXISTS inbound_lease ON inbound(((record#>>'{dispatch,lease,expiresAt}')::bigint)) WHERE status='due';
          CREATE TABLE IF NOT EXISTS outbound(
            id TEXT COLLATE "C" PRIMARY KEY,sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,channel_id TEXT NOT NULL REFERENCES conversations(id),
            message_id TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,record JSONB NOT NULL,UNIQUE(channel_id,message_id));
          CREATE INDEX IF NOT EXISTS outbound_channel_order ON outbound(channel_id,sequence) WHERE status IN ('pending','unknown');
          CREATE INDEX IF NOT EXISTS outbound_due ON outbound(((record->>'dueAt')::bigint),id) WHERE status='pending';
          CREATE INDEX IF NOT EXISTS outbound_lease ON outbound(((record#>>'{lease,expiresAt}')::bigint)) WHERE status='pending';
          CREATE TABLE IF NOT EXISTS media(
            id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES conversations(id),
            reference JSONB NOT NULL, data BYTEA, digest TEXT NOT NULL, staged BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT NOT NULL);
          CREATE INDEX IF NOT EXISTS media_channel ON media(channel_id);
          CREATE TABLE IF NOT EXISTS plugin_state(
            plugin TEXT NOT NULL,owner TEXT NOT NULL,key TEXT COLLATE "C" NOT NULL,version INTEGER NOT NULL,
            expires_at BIGINT,record JSONB NOT NULL,PRIMARY KEY(plugin,owner,key));
        `)
      })
    },
    async health() {
      try {
        await pool.query(
          'SELECT id,endpoint,active,record FROM conversations LIMIT 0'
        )
        await pool.query('SELECT id,record FROM inbound LIMIT 0')
        await pool.query('SELECT id,record FROM outbound LIMIT 0')
        await pool.query(
          'SELECT plugin,owner,key,version,record FROM plugin_state LIMIT 0'
        )
        await pool.query('SELECT id,reference,data FROM media LIMIT 0')
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
