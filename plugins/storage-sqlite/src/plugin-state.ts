import { decodeDurableRecord } from './record-codec.js'
import type { Storage, StateEntry } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { encodeDurableRecord } from '@relanox/storage-support'

export function createStateOperations(
  context: Pick<DatabaseContext, 'db' | 'transaction'>
): Pick<
  Storage,
  'getState' | 'listState' | 'compareAndSetState' | 'deleteState'
> {
  const { db, transaction } = context
  return {
    async getState(ns, key) {
      const row = db
        .prepare(
          "SELECT record FROM plugin_state WHERE plugin=? AND owner=? AND key=? AND record!='null'"
        )
        .get(ns.pluginId, ns.ownerId, key) as { record: string } | undefined

      return row ? decodeDurableRecord<StateEntry>(row.record) : undefined
    },
    async listState(ns, input) {
      const where = ['plugin=?', 'owner=?', "record!='null'"]
      const params: (string | number)[] = [ns.pluginId, ns.ownerId]
      if (input.prefix !== undefined) {
        where.push('substr(key,1,?)=?')
        params.push(input.prefix.length, input.prefix)
      }
      if (input.expiresBefore !== undefined) {
        where.push('expires_at<=?')
        params.push(input.expiresBefore)
      }
      return (
        db
          .prepare(
            `SELECT record FROM plugin_state WHERE ${where.join(' AND ')} ORDER BY key LIMIT ?`
          )
          .all(...params, input.limit) as { record: string }[]
      ).map((row) => decodeDurableRecord<StateEntry>(row.record))
    },
    async compareAndSetState(ns, input) {
      return transaction(() => {
        const old = db
          .prepare(
            'SELECT version,record FROM plugin_state WHERE plugin=? AND owner=? AND key=?'
          )
          .get(ns.pluginId, ns.ownerId, input.key) as
          { version: number; record: string } | undefined

        const active = old?.record !== undefined && old.record !== 'null'
        if (
          input.expectedVersion === null
            ? active
            : !active || old?.version !== input.expectedVersion
        ) {
          return { status: 'conflict' }
        }
        const version = (old?.version ?? 0) + 1

        const entry: StateEntry = {
          key: input.key,
          value: input.value,
          version,
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt }
            : {})
        }

        db.prepare(
          `
            INSERT INTO plugin_state(plugin,owner,key,version,expires_at,record)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(plugin,owner,key) DO UPDATE
            SET version=excluded.version,expires_at=excluded.expires_at,record=excluded.record
          `
        ).run(
          ns.pluginId,
          ns.ownerId,
          input.key,
          version,
          input.expiresAt ?? null,
          encodeDurableRecord(entry)
        )
        return { status: 'updated', version }
      })
    },
    async deleteState(ns, key, version) {
      return transaction(() => {
        const old = db
          .prepare(
            "SELECT version FROM plugin_state WHERE plugin=? AND owner=? AND key=? AND record!='null'"
          )
          .get(ns.pluginId, ns.ownerId, key) as { version: number } | undefined

        if (!old) {
          return { status: 'not_found' }
        }
        if (old.version !== version) {
          return { status: 'conflict' }
        }
        db.prepare(
          `
            UPDATE plugin_state
            SET record='null',expires_at=NULL,version=version+1
            WHERE plugin=?
              AND owner=?
              AND key=?
          `
        ).run(ns.pluginId, ns.ownerId, key)
        return { status: 'updated', version: version + 1 }
      })
    }
  }
}
