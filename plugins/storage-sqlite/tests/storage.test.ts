import type { Storage } from '@relanox/sdk'
import { asset, mediaContract } from '../../../tests/storage/media-contract.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  required,
  snapshot,
  testConversations,
  completion,
  storageContract
} from '../../../tests/contracts/storage-contract.js'
import { createSqliteStorage } from '../src/index.js'

storageContract('SQLite shared storage contract', async () =>
  createSqliteStorage({ filename: ':memory:' })
)

it('initializes idempotently and persists messages and leases across independent connections and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relanox-sqlite-'))
  const filename = join(dir, 'relay.db')

  const open = (): Storage => createSqliteStorage({ filename })

  let a = open()
  let b: ReturnType<typeof open> | undefined
  try {
    expect(await a.health()).toEqual({
      ok: false,
      errorCode: 'storage_unavailable'
    })
    await a.initialize()
    await a.registerConversations(testConversations)
    await a.initialize()
    await a.registerConversations(testConversations)
    expect(await a.health()).toEqual({ ok: true })
    const incoming = asset()
    await a.acceptInbound(
      { ...snapshot(), attachments: [incoming.reference] },
      [incoming]
    )
    const staged = asset('staged')

    const stageInput = {
      channelId: 'channel',
      agent: 'grok' as const,
      endpointIds: ['ep'],
      media: staged,
      maxBytes: 3,
      maxCount: 2,
      maxTotalBytes: 6
    }

    expect(await required(a.media).put(stageInput)).toMatchObject({
      status: 'stored'
    })
    await a.initialize()
    await a.registerConversations(testConversations)
    expect((await a.getInbound('r1'))?.snapshot.text).toBe('question')
    b = open()

    const input = {
      now: 100,
      leaseMs: 10,
      limit: 1,
      leaseOwner: 'a',
      safeRetryAccountIds: []
    }

    const [one, two] = await Promise.all([
      a.takeDue(input),
      b.takeDue({ ...input, leaseOwner: 'b' })
    ])

    expect(one).toHaveLength(1)
    expect(two).toHaveLength(0)
    await a.close()
    a = open()
    await a.initialize()
    await a.registerConversations(testConversations)
    expect(
      await required(a.media).get('channel', incoming.reference.id)
    ).toEqual(incoming)
    expect(await required(a.media).get('channel', 'staged')).toEqual(staged)
    expect(await required(a.media).put(stageInput)).toEqual({
      status: 'stored',
      reference: staged.reference
    })
    expect(await a.takeDue({ ...input, now: 110 })).toEqual([])
    expect((await a.getInbound('r1'))?.dispatch.status).toBe('unknown')
    const r = required(await a.getInbound('r1'))
    await a.requeue({
      kind: 'request',
      id: 'r1',
      expectedVersion: r.version,
      now: 111,
      acknowledgeUnknown: true
    })
    const message = completion()
    await a.enqueueMessage(message)
    await a.close()
    a = open()
    await a.initialize()
    await a.registerConversations(testConversations)
    expect(await a.enqueueMessage(message)).toMatchObject({
      status: 'queued',
      replay: true
    })
    expect((await a.getOutbound(message.outbound.deliveryId))?.chunks).toEqual(
      message.outbound.chunks
    )
  } finally {
    await a.close()
    await b?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

mediaContract('SQLite media durability', async () =>
  createSqliteStorage({ filename: ':memory:' })
)
