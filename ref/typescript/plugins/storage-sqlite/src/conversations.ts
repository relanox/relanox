import type { Storage, ConversationRecord } from '@relanox/sdk'
import {
  encodeDurableRecord,
  equalDurableValues
} from '@relanox/storage-support'
import { decodeDurableRecord } from './record-codec.js'
import type { DatabaseContext } from './database.js'
import { eq } from 'drizzle-orm'
import { conversations } from './schema.js'

export function createConversationOperations(
  context: DatabaseContext
): Pick<Storage, 'registerConversations' | 'getConversation'> {
  return {
    async registerConversations(records) {
      context.transaction(() => {
        context.db.update(conversations).set({ active: 0 }).run()
        for (const record of records) {
          const row = context.db
            .select({ record: conversations.record })
            .from(conversations)
            .where(eq(conversations.id, record.address.id))
            .get()

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

          const values = {
            id: record.address.id,
            endpoint: record.endpoint.id,
            active: 1,
            record: encodeDurableRecord(stored)
          }

          context.db
            .insert(conversations)
            .values(values)
            .onConflictDoUpdate({
              target: conversations.id,
              set: {
                endpoint: values.endpoint,
                active: values.active,
                record: values.record
              }
            })
            .run()
        }
      })
    },
    async getConversation(id, options) {
      return context.readConversation(id, options?.includeInactive)
    }
  }
}
