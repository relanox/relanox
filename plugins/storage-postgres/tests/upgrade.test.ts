import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createPostgresStorage } from '../src/index.js'
import { inbound } from '../src/schema.js'
import { verifySpeechUpgrade } from '../../../tests/storage/upgrade-contract.js'

it.skipIf(!process.env.RELANOX_TEST_POSTGRES_URL)(
  'upgrades saved and pending speech records on PostgreSQL startup without repeating completed processing',
  async () => {
    const schema = `relanox_test_${randomUUID().replaceAll('-', '')}`

    const pool = new Pool({
      connectionString: process.env.RELANOX_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`
    })

    const storage = createPostgresStorage({
      connectionString: { env: 'RELANOX_TEST_POSTGRES_URL' },
      schema
    })

    try {
      await verifySpeechUpgrade(storage, async (record) => {
        await drizzle(pool)
          .update(inbound)
          .set({ record })
          .where(eq(inbound.id, record.snapshot.requestId))
      })
      expect((await storage.getInbound('completed'))?.snapshot).toMatchObject({
        context: { original: true },
        senderId: 'u',
        target: { data: { thread: 'original' } }
      })
    } finally {
      await storage.close()
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await pool.end()
      }
    }
  }
)
