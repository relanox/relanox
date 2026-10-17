import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Storage } from '@relanox/sdk'
import { createSqliteStorage } from '../../storage-sqlite/src/index.js'

/** Reopen the same real database file for webhook recovery checks. */
export async function ingressStorage(
  cleanups: (() => Promise<void>)[]
): Promise<{ filename: string; open(this: void): Promise<Storage> }> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-telegram-ingress-'))
  cleanups.push(async () => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'relay.sqlite')
  return {
    filename,
    async open() {
      const storage = createSqliteStorage({ filename })
      await storage.initialize()
      return storage
    }
  }
}
