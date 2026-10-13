import { decodeDurableRecord } from './record-codec.js'
import type { Storage, StateEntry } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { encodeDurableRecord } from '@relanox/storage-support'
import { and, eq, lte, ne } from 'drizzle-orm'
import { pluginState } from './schema.js'
import { keyPrefix } from './expressions.js'

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
        .select({ record: pluginState.record })
        .from(pluginState)
        .where(
          and(
            eq(pluginState.plugin, ns.pluginId),
            eq(pluginState.owner, ns.ownerId),
            eq(pluginState.key, key),
            ne(pluginState.record, 'null')
          )
        )
        .get()

      return row ? decodeDurableRecord<StateEntry>(row.record) : undefined
    },
    async listState(ns, input) {
      return db
        .select({ record: pluginState.record })
        .from(pluginState)
        .where(
          and(
            eq(pluginState.plugin, ns.pluginId),
            eq(pluginState.owner, ns.ownerId),
            ne(pluginState.record, 'null'),
            input.prefix === undefined
              ? undefined
              : eq(
                  keyPrefix(pluginState.key, input.prefix.length),
                  input.prefix
                ),
            input.expiresBefore === undefined
              ? undefined
              : lte(pluginState.expiresAt, input.expiresBefore)
          )
        )
        .orderBy(pluginState.key)
        .limit(input.limit)
        .all()
        .map((row) => decodeDurableRecord<StateEntry>(row.record))
    },
    async compareAndSetState(ns, input) {
      return transaction(() => {
        const old = db
          .select({ version: pluginState.version, record: pluginState.record })
          .from(pluginState)
          .where(
            and(
              eq(pluginState.plugin, ns.pluginId),
              eq(pluginState.owner, ns.ownerId),
              eq(pluginState.key, input.key)
            )
          )
          .get()

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

        const values = {
          plugin: ns.pluginId,
          owner: ns.ownerId,
          key: input.key,
          version,
          expiresAt: input.expiresAt ?? null,
          record: encodeDurableRecord(entry)
        }

        db.insert(pluginState)
          .values(values)
          .onConflictDoUpdate({
            target: [pluginState.plugin, pluginState.owner, pluginState.key],
            set: { version, expiresAt: values.expiresAt, record: values.record }
          })
          .run()
        return { status: 'updated', version }
      })
    },
    async deleteState(ns, key, version) {
      return transaction(() => {
        const old = db
          .select({ version: pluginState.version })
          .from(pluginState)
          .where(
            and(
              eq(pluginState.plugin, ns.pluginId),
              eq(pluginState.owner, ns.ownerId),
              eq(pluginState.key, key),
              ne(pluginState.record, 'null')
            )
          )
          .get()

        if (!old) {
          return { status: 'not_found' }
        }
        if (old.version !== version) {
          return { status: 'conflict' }
        }
        db.update(pluginState)
          .set({ record: 'null', expiresAt: null, version: version + 1 })
          .where(
            and(
              eq(pluginState.plugin, ns.pluginId),
              eq(pluginState.owner, ns.ownerId),
              eq(pluginState.key, key)
            )
          )
          .run()
        return { status: 'updated', version: version + 1 }
      })
    }
  }
}
