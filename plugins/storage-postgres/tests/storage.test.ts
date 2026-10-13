import { asset, mediaContract } from '../../../tests/storage/media-contract.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Storage, DueWork, InboundRecord } from '@relanox/sdk'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  completion,
  required,
  snapshot,
  testConversations,
  storageContract
} from '../../../tests/contracts/storage-contract.js'
import { createPostgresStorage, postgresStoragePlugin } from '../src/index.js'

const enabled = Boolean(process.env.RELANOX_TEST_POSTGRES_URL)

const schemaName = (): string =>
  `relanox_test_${randomUUID().replaceAll('-', '')}`

const open = (schema: string): Storage =>
  createPostgresStorage({
    connectionString: { env: 'RELANOX_TEST_POSTGRES_URL' },
    schema
  })

async function drop(schema: string): Promise<void> {
  const connectionString = process.env.RELANOX_TEST_POSTGRES_URL
  if (!connectionString) {
    throw new Error('Test PostgreSQL URL required')
  }
  const pool = new Pool({ connectionString })
  try {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
  } finally {
    await pool.end()
  }
}

describe.skipIf(!enabled)('postgreSQL real database', () => {
  storageContract('PostgreSQL shared storage contract', async () => {
    const schema = schemaName()
    const storage = open(schema)
    return {
      ...storage,
      async close(): Promise<void> {
        try {
          await storage.close()
        } finally {
          await drop(schema)
        }
      }
    }
  })

  mediaContract('PostgreSQL media durability', async () => {
    const schema = schemaName()
    const storage = open(schema)
    return {
      ...storage,
      async close(): Promise<void> {
        try {
          await storage.close()
        } finally {
          await drop(schema)
        }
      }
    }
  })

  it('adopts the populated pre-ORM schema and preserves records and identity order across concurrent initialization and reopen', async () => {
    const schema = schemaName()

    const pool = new Pool({
      connectionString: process.env.RELANOX_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`
    })

    let storage = open(schema)
    const peer = open(schema)
    const incoming = asset('legacy-media')

    const originalSnapshot = {
      ...snapshot(),
      attachments: [incoming.reference]
    }

    const original: InboundRecord = {
      snapshot: originalSnapshot,
      version: 3,
      dispatch: {
        status: 'due',
        attempts: 1,
        dueAt: 100,
        lease: { token: 'historical-lease', version: 3, expiresAt: 200 }
      }
    }

    const first = completion('channel', 'z-first')
    const second = completion('channel', 'a-second')
    const namespace = { pluginId: 'dot', ownerId: 'historical' }
    const state = { key: 'cursor', value: { sequence: 9 }, version: 4 }
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`)
      // Historical DDL and inserts describe the released pre-ORM database, not the implementation under test.
      await pool.query(
        await readFile(new URL('legacy-schema.sql', import.meta.url), 'utf8')
      )
      const conversation = required(testConversations[0])
      await pool.query(
        'INSERT INTO conversations(id,endpoint,active,record) VALUES($1,$2,TRUE,$3::jsonb)',
        ['channel', 'ep', JSON.stringify(conversation)]
      )
      await pool.query(
        'INSERT INTO inbound(id,channel,account,event,endpoint,accepted_at,status,version,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
        [
          'r1',
          'telegram',
          'a',
          'r1',
          'ep',
          100,
          'due',
          3,
          JSON.stringify(original)
        ]
      )
      for (const input of [first, second]) {
        await pool.query(
          'INSERT INTO outbound(id,channel_id,message_id,digest,status,version,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
          [
            input.outbound.deliveryId,
            'channel',
            input.message.messageId,
            'e8e8d2a4cf563c2458f6c427f5372dfcefd8543634f43e912d8c156eb6b3c84e',
            'pending',
            1,
            JSON.stringify(input.outbound)
          ]
        )
      }
      await pool.query(
        'INSERT INTO media(id,channel_id,reference,data,digest,staged,created_at) VALUES($1,$2,$3::jsonb,$4,$5,FALSE,$6)',
        [
          incoming.reference.id,
          'channel',
          JSON.stringify(incoming.reference),
          Buffer.from(incoming.data),
          'legacy-media-digest',
          100
        ]
      )
      await pool.query(
        'INSERT INTO plugin_state(plugin,owner,key,version,record) VALUES($1,$2,$3,$4,$5::jsonb)',
        [
          namespace.pluginId,
          namespace.ownerId,
          state.key,
          state.version,
          JSON.stringify(state)
        ]
      )
      await Promise.all([storage.initialize(), peer.initialize()])
      expect(await storage.getConversation('channel')).toEqual(conversation)
      expect(await storage.getInbound('r1')).toEqual(original)
      expect(await storage.getOutbound(first.outbound.deliveryId)).toEqual(
        first.outbound
      )
      expect(
        await required(storage.media).get('channel', incoming.reference.id)
      ).toEqual(incoming)
      expect(await storage.getState(namespace, state.key)).toEqual(state)
      expect(await storage.getMessageReceipt(first)).toEqual({
        status: 'queued',
        deliveryId: first.outbound.deliveryId,
        replay: true
      })

      const lease = required(
        (
          await storage.takeDue({
            now: 110,
            limit: 1,
            leaseMs: 10,
            leaseOwner: 'after-migration',
            safeRetryAccountIds: []
          })
        )[0]
      )

      expect(lease.kind).toBe('send')
      if (lease.kind === 'send') {
        expect(lease.record.deliveryId).toBe(first.outbound.deliveryId)
      }
      await storage.close()
      storage = open(schema)
      await storage.initialize()
      expect(await storage.health()).toEqual({ ok: true })
      expect(
        (await storage.getOutbound(first.outbound.deliveryId))?.lease
      ).toEqual(lease.lease)
      expect(await storage.getOutbound(second.outbound.deliveryId)).toEqual(
        second.outbound
      )
      expect(
        await required(storage.media).get('channel', incoming.reference.id)
      ).toEqual(incoming)
      expect(await storage.getState(namespace, state.key)).toEqual(state)
    } finally {
      await storage.close()
      await peer.close()
      await pool.end()
      await drop(schema)
    }
  })

  it('initializes idempotently and retains fenced leases, media and messages across independent pools and restart', async () => {
    const schema = schemaName()
    let a = open(schema)
    const b = open(schema)
    try {
      expect(await a.health()).toEqual({
        ok: false,
        errorCode: 'storage_unavailable'
      })
      await a.initialize()
      await a.registerConversations(testConversations)
      await a.initialize()
      await a.registerConversations(testConversations)
      expect(await b.health()).toEqual({ ok: true })
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

      const input = {
        now: 100,
        leaseMs: 10,
        limit: 1,
        leaseOwner: 'a',
        safeRetryAccountIds: []
      }

      const attempts = await Promise.all([
        a.takeDue(input),
        b.takeDue({ ...input, leaseOwner: 'b' })
      ])

      expect(attempts.flat()).toHaveLength(1)
      const oldLease = required(attempts.flat()[0]).lease
      await a.close()
      a = open(schema)
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
      expect(
        await a.settleAttempt({
          kind: 'dispatch',
          id: 'r1',
          lease: oldLease,
          outcome: { status: 'accepted' },
          now: 111,
          nextDueAt: 111
        })
      ).toEqual({ status: 'conflict' })
      const message = completion()
      await a.enqueueMessage(message)
      await a.close()
      a = open(schema)
      await a.initialize()
      await a.registerConversations(testConversations)
      expect(await b.enqueueMessage(message)).toMatchObject({
        status: 'queued',
        replay: true
      })
      expect(
        (await a.getOutbound(message.outbound.deliveryId))?.chunks
      ).toEqual(message.outbound.chunks)
    } finally {
      await a.close()
      await b.close()
      await drop(schema)
    }
  })

  it('serializes incoming dedup, scoped message idempotency and state CAS across separate pools', async () => {
    const schema = schemaName()
    const a = open(schema)
    const b = open(schema)
    try {
      await a.initialize()
      await a.registerConversations(testConversations)

      const receipts = await Promise.all([
        a.acceptInbound(snapshot()),
        b.acceptInbound({ ...snapshot('other'), source: snapshot().source })
      ])

      expect(receipts.filter((result) => !result.duplicate)).toHaveLength(1)
      expect(new Set(receipts.map((result) => result.requestId)).size).toBe(1)
      const message = completion()

      const messages = await Promise.all([
        a.enqueueMessage(message),
        b.enqueueMessage(message)
      ])

      expect(
        messages.filter(
          (result) => result.status === 'queued' && !result.replay
        )
      ).toHaveLength(1)
      expect(
        messages.filter((result) => result.status === 'queued' && result.replay)
      ).toHaveLength(1)
      await a.acceptInbound(snapshot('independent', 100, 'ep2'))
      expect(
        await b.enqueueMessage({
          ...completion('ep2', 'message', 'ep2'),
          endpointIds: ['ep2']
        })
      ).toMatchObject({ status: 'queued', replay: false })
      const ns = { pluginId: 'dot', ownerId: 'a' }

      const creates = await Promise.all([
        a.compareAndSetState(ns, {
          key: 'cursor',
          expectedVersion: null,
          value: 'a'
        }),
        b.compareAndSetState(ns, {
          key: 'cursor',
          expectedVersion: null,
          value: 'b'
        })
      ])

      expect(
        creates.filter((result) => result.status === 'updated')
      ).toHaveLength(1)
      expect(
        creates.filter((result) => result.status === 'conflict')
      ).toHaveLength(1)

      const updates = await Promise.all([
        a.compareAndSetState(ns, {
          key: 'cursor',
          expectedVersion: 1,
          value: 'next-a'
        }),
        b.compareAndSetState(ns, {
          key: 'cursor',
          expectedVersion: 1,
          value: 'next-b'
        })
      ])

      expect(updates.filter((result) => result.status === 'updated')).toEqual([
        { status: 'updated', version: 2 }
      ])
      expect(
        updates.filter((result) => result.status === 'conflict')
      ).toHaveLength(1)
    } finally {
      await a.close()
      await b.close()
      await drop(schema)
    }
  })

  it('reopens partial delivery receipts and resumes the same unsent chunk only after explicit unknown recovery', async () => {
    const schema = schemaName()
    let a = open(schema)
    const b = open(schema)
    try {
      await a.initialize()
      await a.registerConversations(testConversations)
      await a.acceptInbound(snapshot())

      const dispatch = required(
        (
          await a.takeDue({
            now: 100,
            leaseMs: 10,
            limit: 1,
            leaseOwner: 'dispatch',
            safeRetryAccountIds: []
          })
        )[0]
      )

      await a.settleAttempt({
        kind: 'dispatch',
        id: 'r1',
        lease: dispatch.lease,
        outcome: { status: 'accepted' },
        now: 101,
        nextDueAt: 101
      })
      await a.enqueueMessage(completion())

      const due = async (
        s: Storage,
        now: number
      ): Promise<readonly DueWork[]> =>
        s.takeDue({
          now,
          leaseMs: 10,
          limit: 1,
          leaseOwner: 'send',
          safeRetryAccountIds: []
        })

      const first = required((await due(a, 110))[0])
      expect(
        await b.settleAttempt({
          kind: 'send',
          id: 'd-channel-message',
          lease: first.lease,
          outcome: {
            status: 'sent',
            receipt: { platformMessageId: 'first-chunk' }
          },
          now: 111,
          nextDueAt: 112
        })
      ).toMatchObject({ status: 'updated' })
      const unsent = required((await due(b, 112))[0])
      await a.close()
      a = open(schema)
      await a.initialize()
      await a.registerConversations(testConversations)
      expect(await a.getOutbound('d-channel-message')).toMatchObject({
        currentChunk: 1,
        attempts: 0,
        receipts: [{ platformMessageId: 'first-chunk' }],
        lease: unsent.lease
      })
      expect(await due(a, 122)).toEqual([])
      const unknown = required(await a.getOutbound('d-channel-message'))
      expect(unknown.status).toBe('unknown')
      expect(
        await a.requeue({
          kind: 'delivery',
          id: 'd-channel-message',
          expectedVersion: unknown.version,
          now: 123,
          acknowledgeUnknown: true
        })
      ).toMatchObject({ status: 'updated' })
      const next = required((await due(a, 123))[0])
      expect(next.kind).toBe('send')
      if (next.kind === 'send') {
        expect(next.record).toMatchObject({
          currentChunk: 1,
          chunks: [{ idempotencyKey: 'c1' }, { idempotencyKey: 'c2' }],
          receipts: [{ platformMessageId: 'first-chunk' }]
        })
      }
      expect(
        await b.settleAttempt({
          kind: 'send',
          id: 'd-channel-message',
          lease: unsent.lease,
          outcome: { status: 'sent', receipt: { platformMessageId: 'stale' } },
          now: 124,
          nextDueAt: 125
        })
      ).toEqual({ status: 'conflict' })
      await b.settleAttempt({
        kind: 'send',
        id: 'd-channel-message',
        lease: next.lease,
        outcome: {
          status: 'sent',
          receipt: { platformMessageId: 'second-chunk' }
        },
        now: 124,
        nextDueAt: 125
      })
      expect(await a.getOutbound('d-channel-message')).toMatchObject({
        status: 'sent',
        currentChunk: 2,
        receipts: [
          { platformMessageId: 'first-chunk' },
          { platformMessageId: 'second-chunk' }
        ]
      })
    } finally {
      await a.close()
      await b.close()
      await drop(schema)
    }
  })
})

it('validates SecretRef, SQL identifiers and bounded pool config without exposing missing credentials', () => {
  const base = { connectionString: { env: 'RELANOX_TEST_POSTGRES_URL' } }
  expect(postgresStoragePlugin.validateConfig(base)).toMatchObject({
    connectionString: base.connectionString,
    schema: 'public',
    maxConnections: 10
  })
  for (const input of [
    { connectionString: 'postgresql://secret' },
    { ...base, schema: 'public; DROP SCHEMA public' },
    { ...base, maxConnections: 0 },
    { ...base, statementTimeoutMs: 0 },
    { ...base, unrecognized: true }
  ]) {
    expect(() => postgresStoragePlugin.validateConfig(input)).toThrow()
  }
  expect(() =>
    createPostgresStorage({
      connectionString: {
        env: `RELANOX_MISSING_${randomUUID().replaceAll('-', '')}`
      }
    })
  ).toThrow('PostgreSQL connection secret is unavailable')
})
