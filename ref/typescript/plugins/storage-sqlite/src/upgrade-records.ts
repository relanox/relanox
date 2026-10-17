import { and, eq, gt, isNotNull } from 'drizzle-orm'
import {
  encodeDurableRecord,
  upgradeSpeechRecord
} from '@relanox/storage-support'
import type { InboundRecord } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { decodeDurableRecord } from './record-codec.js'
import { inbound } from './schema.js'
import { jsonValue } from './expressions.js'

export function upgradeRecords(db: DatabaseContext['db']): void {
  let cursor: string | undefined
  for (;;) {
    const afterId = cursor

    const last = db.transaction(
      (tx) => {
        const rows = tx
          .select({ id: inbound.id, record: inbound.record })
          .from(inbound)
          .where(
            and(
              isNotNull(jsonValue(inbound.record, '$.snapshot.speechToText')),
              afterId === undefined ? undefined : gt(inbound.id, afterId)
            )
          )
          .orderBy(inbound.id)
          .limit(100)
          .all()

        for (const row of rows) {
          const record = upgradeSpeechRecord(
            decodeDurableRecord<InboundRecord>(row.record)
          )

          tx.update(inbound)
            .set({
              record: encodeDurableRecord(record),
              version: record.version
            })
            .where(eq(inbound.id, row.id))
            .run()
        }
        return rows.at(-1)?.id
      },
      { behavior: 'immediate' }
    )

    if (last === undefined) {
      return
    }
    cursor = last
  }
}
