import Database from 'better-sqlite3'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import type { InboundRecord, Storage } from '@relanox/sdk'
import { createSqliteStorage } from '../src/index.js'
import { asset } from '../../../tests/storage/media-contract.js'
import {
  completion,
  required,
  snapshot,
  testConversations
} from '../../../tests/contracts/storage-contract.js'

/** Seeds the historical on-disk format directly, without invoking current storage or its migrations. */
async function seedLegacyFile(filename: string): Promise<void> {
  const ddl = await readFile(
    new URL('legacy-schema.sql', import.meta.url),
    'utf8'
  )

  const db = new Database(filename)
  try {
    db.exec(ddl)
    const incoming = asset('legacy-media')
    const input = { ...snapshot(), attachments: [incoming.reference] }

    const conversation = {
      ...required(testConversations[0]),
      target: input.target
    }

    db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(
      'channel',
      'ep',
      1,
      JSON.stringify(conversation)
    )

    const record: InboundRecord = {
      snapshot: input,
      version: 2,
      dispatch: {
        status: 'due',
        attempts: 0,
        dueAt: 100,
        lease: { token: 'legacy-worker', version: 2, expiresAt: 120 }
      }
    }

    db.prepare('INSERT INTO inbound VALUES(?,?,?,?,?,?,?,?,?)').run(
      'r1',
      'telegram',
      'a',
      'r1',
      'ep',
      100,
      'due',
      2,
      JSON.stringify(record)
    )
    for (const messageId of ['z-first', 'a-second']) {
      const message = completion('channel', messageId)
      // Historical SHA-256 of ["AB",[]], independent of the production digest implementation.
      db.prepare('INSERT INTO outbound VALUES(?,?,?,?,?,?,?)').run(
        message.outbound.deliveryId,
        'channel',
        messageId,
        'e8e8d2a4cf563c2458f6c427f5372dfcefd8543634f43e912d8c156eb6b3c84e',
        'pending',
        1,
        JSON.stringify(message.outbound)
      )
    }
    db.prepare('INSERT INTO media VALUES(?,?,?,?,?,?,?)').run(
      incoming.reference.id,
      'channel',
      JSON.stringify(incoming.reference),
      Buffer.from(incoming.data),
      'legacy-media-digest',
      0,
      100
    )
    db.prepare('INSERT INTO plugin_state VALUES(?,?,?,?,?,?)').run(
      'telegram',
      'a',
      'cursor',
      7,
      200,
      JSON.stringify({
        key: 'cursor',
        value: { offset: 42 },
        version: 7,
        expiresAt: 200
      })
    )
    db.prepare('INSERT INTO plugin_state VALUES(?,?,?,?,?,?)').run(
      'telegram',
      'a',
      'removed',
      9,
      null,
      'null'
    )
  } finally {
    db.close()
  }
}

it('adopts a pre-ORM file without losing records, queue order, media or state versions and reopens it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relanox-legacy-sqlite-'))
  const filename = join(dir, 'legacy.db')
  let storage: Storage | undefined
  try {
    await seedLegacyFile(filename)
    storage = createSqliteStorage({ filename })
    await storage.initialize()
    await storage.initialize()
    expect(await storage.health()).toEqual({ ok: true })
    expect((await storage.getConversation('channel'))?.target).toEqual(
      snapshot().target
    )
    expect(await storage.acceptInbound(snapshot())).toEqual({
      requestId: 'r1',
      duplicate: true
    })
    expect(await storage.getInbound('r1')).toMatchObject({
      version: 2,
      snapshot: { text: 'question' },
      dispatch: { lease: { token: 'legacy-worker', expiresAt: 120 } }
    })
    expect(
      await required(storage.media).get('channel', 'legacy-media')
    ).toEqual(asset('legacy-media'))
    expect(
      await storage.enqueueMessage(completion('channel', 'z-first'))
    ).toEqual({
      status: 'queued',
      deliveryId: 'd-channel-z-first',
      replay: true
    })
    const ns = { pluginId: 'telegram', ownerId: 'a' }
    expect(await storage.getState(ns, 'cursor')).toEqual({
      key: 'cursor',
      value: { offset: 42 },
      version: 7,
      expiresAt: 200
    })
    expect(
      await storage.compareAndSetState(ns, {
        key: 'cursor',
        expectedVersion: 7,
        value: { offset: 43 }
      })
    ).toEqual({ status: 'updated', version: 8 })
    expect(await storage.getState(ns, 'removed')).toBeUndefined()
    expect(
      await storage.compareAndSetState(ns, {
        key: 'removed',
        expectedVersion: null,
        value: true
      })
    ).toEqual({ status: 'updated', version: 10 })

    const due = {
      now: 110,
      leaseMs: 10,
      limit: 10,
      leaseOwner: 'new-worker',
      safeRetryAccountIds: []
    }

    const work = await storage.takeDue(due)
    expect(work).toHaveLength(1)
    expect(work[0]).toMatchObject({
      kind: 'send',
      record: { deliveryId: 'd-channel-z-first', version: 2 }
    })
    await storage.close()
    storage = createSqliteStorage({ filename })
    await storage.initialize()
    expect(await storage.getState(ns, 'cursor')).toMatchObject({
      value: { offset: 43 },
      version: 8
    })
    expect(
      await required(storage.media).get('channel', 'legacy-media')
    ).toEqual(asset('legacy-media'))
    expect(await storage.takeDue(due)).toEqual([])
    expect((await storage.getOutbound('d-channel-z-first'))?.lease).toEqual(
      required(work[0]).lease
    )
    expect((await storage.getInbound('r1'))?.dispatch.lease?.token).toBe(
      'legacy-worker'
    )
  } finally {
    await storage?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
