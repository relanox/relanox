import type { Storage, ConversationRecord } from '@relanox/sdk'
import {
  encodeDurableRecord,
  equalDurableValues
} from '@relanox/storage-support'
import { decodeDurableRecord } from './record-codec.js'
import type { DatabaseContext } from './database.js'

export function createConversationOperations(
  context: DatabaseContext
): Pick<Storage, 'registerConversations' | 'getConversation'> {
  return {
    async registerConversations(records) {
      context.transaction(() => {
        context.db.prepare('UPDATE conversations SET active=0').run()
        for (const record of records) {
          const row = context.db
            .prepare('SELECT record FROM conversations WHERE id=?')
            .get(record.address.id) as { record: string } | undefined

          const previous = row
            ? decodeDurableRecord<ConversationRecord>(row.record)
            : undefined

          if (
            previous &&
            (!equalDurableValues(previous.address, record.address) ||
              !equalDurableValues(previous.endpoint, record.endpoint))
          ) {
            throw new Error('Channel identity cannot change ownership')
          }

          const stored = {
            address: record.address,
            endpoint: record.endpoint,
            ...(previous?.target ? { target: previous.target } : {})
          }

          context.db
            .prepare(
              'INSERT INTO conversations(id,endpoint,active,record) VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,active=1,record=excluded.record'
            )
            .run(
              record.address.id,
              record.endpoint.id,
              encodeDurableRecord(stored)
            )
        }
      })
    },
    async getConversation(id, options) {
      return context.readConversation(id, options?.includeInactive)
    }
  }
}
