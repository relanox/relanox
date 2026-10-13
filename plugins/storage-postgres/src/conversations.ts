import type { Storage } from '@relanox/sdk'
import { equalDurableValues } from '@relanox/storage-support'
import { notInArray } from 'drizzle-orm'
import { conversations } from './schema.js'
import type { DatabaseContext } from './database.js'
import { durable } from './database.js'

export function createConversationOperations(
  context: DatabaseContext
): Pick<Storage, 'registerConversations' | 'getConversation'> {
  return {
    async registerConversations(records) {
      await context.transaction(async (client) => {
        const ids = records.map((record) => record.address.id)
        await client
          .update(conversations)
          .set({ active: false })
          .where(ids.length > 0 ? notInArray(conversations.id, ids) : undefined)
        for (const record of records) {
          const previous = await context.readConversation(
            client,
            record.address.id,
            true
          )

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
            active: true,
            record: durable(stored)
          }

          await client
            .insert(conversations)
            .values(values)
            .onConflictDoUpdate({
              target: conversations.id,
              set: {
                endpoint: values.endpoint,
                active: true,
                record: durable(stored)
              }
            })
        }
      })
    },
    async getConversation(id, options) {
      return context.readConversation(context.db, id, options?.includeInactive)
    }
  }
}
