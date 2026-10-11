import type { Storage, StateEntry } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { boundedLimit } from './database.js'
import { encodeDurableRecord } from './record-codec.js'

export function createStateOperations(
  context: Pick<DatabaseContext, 'pool' | 'query' | 'transaction'>
): Pick<
  Storage,
  'getState' | 'listState' | 'compareAndSetState' | 'deleteState'
> {
  const { pool, query, transaction } = context
  return {
    async getState(ns, key) {
      return (
        await query<{ record: StateEntry }>(
          pool,
          `
            SELECT record
            FROM plugin_state
            WHERE plugin=$1
              AND owner=$2
              AND key=$3
              AND record!='null'::jsonb
          `,
          [ns.pluginId, ns.ownerId, key]
        )
      )[0]?.record
    },
    async listState(ns, input) {
      const params: unknown[] = [ns.pluginId, ns.ownerId]
      const where = ['plugin=$1', 'owner=$2', "record!='null'::jsonb"]
      if (input.prefix !== undefined) {
        params.push(input.prefix)
        where.push(`starts_with(key,$${params.length})`)
      }
      if (input.expiresBefore !== undefined) {
        params.push(input.expiresBefore)
        where.push(`expires_at<=$${params.length}`)
      }
      params.push(boundedLimit(input.limit))
      return (
        await query<{ record: StateEntry }>(
          pool,
          `
            SELECT record
            FROM plugin_state
            WHERE ${where.join(' AND ')}
            ORDER BY key
            LIMIT $${params.length}
          `,
          params
        )
      ).map((row) => row.record)
    },
    async compareAndSetState(ns, input) {
      return transaction(async (client) => {
        const old = (
          await query<{ version: number; active: boolean }>(
            client,
            `
              SELECT version,record!='null'::jsonb AS active
              FROM plugin_state
              WHERE plugin=$1
                AND owner=$2
                AND key=$3
            `,
            [ns.pluginId, ns.ownerId, input.key]
          )
        )[0]

        if (
          input.expectedVersion === null
            ? old?.active
            : !old?.active || old.version !== input.expectedVersion
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

        const params = [
          ns.pluginId,
          ns.ownerId,
          input.key,
          version,
          input.expiresAt ?? null,
          encodeDurableRecord(entry)
        ]

        const changed = !old
          ? await query(
              client,
              `
                INSERT INTO plugin_state(plugin,owner,key,version,expires_at,record)
                VALUES($1,$2,$3,$4,$5,$6::jsonb)
                ON CONFLICT DO NOTHING
                RETURNING version
              `,
              params
            )
          : await query(
              client,
              `
                UPDATE plugin_state
                SET version=$4,expires_at=$5,record=$6::jsonb
                WHERE plugin=$1
                  AND owner=$2
                  AND key=$3
                  AND version=$7
                RETURNING version
              `,
              [...params, old.version]
            )

        return changed.length > 0
          ? { status: 'updated', version }
          : { status: 'conflict' }
      })
    },
    async deleteState(ns, key, version) {
      return transaction(async (client) => {
        const old = (
          await query<{ version: number }>(
            client,
            `
              SELECT version
              FROM plugin_state
              WHERE plugin=$1
                AND owner=$2
                AND key=$3
                AND record!='null'::jsonb
            `,
            [ns.pluginId, ns.ownerId, key]
          )
        )[0]

        if (!old) {
          return { status: 'not_found' }
        }
        if (old.version !== version) {
          return { status: 'conflict' }
        }
        await client.query(
          `
            UPDATE plugin_state
            SET record='null'::jsonb,expires_at=NULL,version=version+1
            WHERE plugin=$1
              AND owner=$2
              AND key=$3
              AND version=$4
          `,
          [ns.pluginId, ns.ownerId, key, version]
        )
        return { status: 'updated', version: version + 1 }
      })
    }
  }
}
