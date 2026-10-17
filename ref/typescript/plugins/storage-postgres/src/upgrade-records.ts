import { and, eq, gt, isNotNull, sql } from 'drizzle-orm'
import { upgradeSpeechRecord } from '@relanox/storage-support'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { inbound } from './schema.js'

export async function upgradeRecords(db: NodePgDatabase): Promise<void> {
  let cursor: string | undefined
  for (;;) {
    const afterId = cursor

    const last = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: inbound.id, record: inbound.record })
        .from(inbound)
        .where(
          and(
            isNotNull(sql`${inbound.record}#>'{snapshot,speechToText}'`),
            afterId === undefined ? undefined : gt(inbound.id, afterId)
          )
        )
        .orderBy(inbound.id)
        .limit(100)
        .for('update')

      for (const row of rows) {
        const record = upgradeSpeechRecord(row.record)
        await tx
          .update(inbound)
          .set({ record, version: record.version })
          .where(eq(inbound.id, row.id))
      }
      return rows.at(-1)?.id
    })

    if (last === undefined) {
      return
    }
    cursor = last
  }
}
