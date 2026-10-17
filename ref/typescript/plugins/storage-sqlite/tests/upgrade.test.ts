import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createSqliteStorage } from '../src/index.js'
import { openDatabase } from '../src/database.js'
import { inbound } from '../src/schema.js'
import { verifySpeechUpgrade } from '../../../tests/storage/upgrade-contract.js'

it('upgrades saved and pending speech records on SQLite startup without repeating completed processing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-upgrade-'))
  const config = { filename: join(directory, 'relay.sqlite') }
  const storage = createSqliteStorage(config)
  const writer = openDatabase(config)
  try {
    await verifySpeechUpgrade(storage, async (record) => {
      writer.db
        .update(inbound)
        .set({ record: JSON.stringify(record) })
        .where(eq(inbound.id, record.snapshot.requestId))
        .run()
    })
    expect((await storage.getInbound('completed'))?.snapshot).toMatchObject({
      context: { original: true },
      senderId: 'u',
      target: { data: { thread: 'original' } }
    })
  } finally {
    writer.connection.close()
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  }
})
