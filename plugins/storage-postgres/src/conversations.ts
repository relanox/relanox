import type { Storage, ConversationRecord } from '@relanox/sdk'
import {
  encodeDurableRecord,
  equalDurableValues
} from '@relanox/storage-support'
import type { DatabaseContext } from './database.js'

export function createConversationOperations(
  context: DatabaseContext
): Pick<Storage, 'registerConversations' | 'getConversation'> {
  return {
    async registerConversations(records) {
      await context.transaction(async (client) => {
        await client.query(
          'UPDATE conversations SET active=FALSE WHERE NOT(id=ANY($1::text[]))',
          [records.map((record) => record.address.id)]
        )
        for (const record of records) {
          const previous = (
            await context.query<{ record: ConversationRecord }>(
              client,
              'SELECT record FROM conversations WHERE id=$1 FOR UPDATE',
              [record.address.id]
            )
          )[0]?.record

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

          await client.query(
            'INSERT INTO conversations(id,endpoint,active,record) VALUES($1,$2,TRUE,$3::jsonb) ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,active=TRUE,record=excluded.record',
            [record.address.id, record.endpoint.id, encodeDurableRecord(stored)]
          )
        }
      })
    },
    async getConversation(id, options) {
      return context.readConversation(
        context.pool,
        id,
        options?.includeInactive
      )
    }
  }
}
