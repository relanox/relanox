import type { Storage, StateEntry, StateNamespace } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { boundedLimit, durable } from './database.js'
import { and, eq, lte, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { pluginState } from './schema.js'

function namespace(ns: StateNamespace, key?: string): SQL | undefined {
  return and(
    eq(pluginState.plugin, ns.pluginId),
    eq(pluginState.owner, ns.ownerId),
    key === undefined ? undefined : eq(pluginState.key, key)
  )
}

const active = sql<boolean>`${pluginState.record} != 'null'::jsonb`

export function createStateOperations(
  context: Pick<DatabaseContext, 'db' | 'transaction'>
): Pick<
  Storage,
  'getState' | 'listState' | 'compareAndSetState' | 'deleteState'
> {
  const { db, transaction } = context
  return {
    async getState(ns, key) {
      return (
        (
          await db
            .select({ record: pluginState.record })
            .from(pluginState)
            .where(and(namespace(ns, key), active))
        )[0]?.record ?? undefined
      )
    },
    async listState(ns, input) {
      const rows = await db
        .select({ record: pluginState.record })
        .from(pluginState)
        .where(
          and(
            namespace(ns),
            active,
            input.prefix === undefined
              ? undefined
              : sql`starts_with(${pluginState.key}, ${input.prefix})`,
            input.expiresBefore === undefined
              ? undefined
              : lte(pluginState.expiresAt, input.expiresBefore)
          )
        )
        .orderBy(pluginState.key)
        .limit(boundedLimit(input.limit))

      return rows.flatMap((row) => (row.record === null ? [] : [row.record]))
    },
    async compareAndSetState(ns, input) {
      return transaction(async (client) => {
        const where = namespace(ns, input.key)

        const old = (
          await client
            .select({ version: pluginState.version, active })
            .from(pluginState)
            .where(where)
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

        const values = {
          plugin: ns.pluginId,
          owner: ns.ownerId,
          key: input.key,
          version,
          expiresAt: input.expiresAt ?? null,
          record: durable(entry)
        }

        const changed = !old
          ? await client
              .insert(pluginState)
              .values(values)
              .onConflictDoNothing()
              .returning({ version: pluginState.version })
          : await client
              .update(pluginState)
              .set({
                version,
                expiresAt: values.expiresAt,
                record: durable(entry)
              })
              .where(and(where, eq(pluginState.version, old.version)))
              .returning({ version: pluginState.version })

        return changed.length > 0
          ? { status: 'updated', version }
          : { status: 'conflict' }
      })
    },
    async deleteState(ns, key, version) {
      return transaction(async (client) => {
        const where = and(namespace(ns, key), active)

        const old = (
          await client
            .select({ version: pluginState.version })
            .from(pluginState)
            .where(where)
        )[0]

        if (!old) {
          return { status: 'not_found' }
        }
        if (old.version !== version) {
          return { status: 'conflict' }
        }
        await client
          .update(pluginState)
          .set({
            record: sql`'null'::jsonb`,
            expiresAt: null,
            version: sql`${pluginState.version} + 1`
          })
          .where(and(where, eq(pluginState.version, version)))
        return { status: 'updated', version: version + 1 }
      })
    }
  }
}
