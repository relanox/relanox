import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { Storage } from '../../packages/sdk/src/index.js'
import { asset } from './media-contract.js'
import {
  completion,
  required,
  snapshot,
  testConversations
} from '../contracts/storage-contract.js'

const base = asset('voice')

const audio = {
  ...base,
  reference: {
    ...base.reference,
    kind: 'audio' as const,
    mimeType: 'audio/wav',
    fileName: 'voice.wav'
  }
}

const input = {
  ...snapshot(),
  attachments: [audio.reference],
  middleware: [{ id: 'prefix', options: { prefix: 'processed' } }]
}

const scan = {
  now: 100,
  leaseMs: 100,
  limit: 1,
  leaseOwner: 'middleware-test',
  safeRetryAccountIds: []
}

const pending = { channelIds: ['channel'], endpointIds: ['ep'], limit: 20 }

/** Protect preparation visibility, fencing and retention in both real storage implementations. */
export function middlewareContract(
  name: string,
  open: () => Promise<Storage>
): void {
  describe(name, () => {
    let storage: Storage
    beforeEach(async () => {
      storage = await open()
      await storage.initialize()
      await storage.registerConversations(testConversations)
      await storage.acceptInbound(input, [audio])
    })
    afterEach(async () => storage.close())

    it('filters unfinished preparation before limiting reads and prevents early replies', async () => {
      expect(await storage.listPendingInbound(pending)).toEqual([])
      const message = completion()
      const reply = { requestId: 'r1', kind: 'final' as const }
      expect(
        await storage.enqueueMessage({
          ...message,
          message: { ...message.message, reply },
          outbound: { ...message.outbound, reply }
        })
      ).toEqual({ status: 'not_found' })
      await storage.acceptInbound({ ...snapshot('ready', 90), middleware: [] })
      expect(
        (
          await storage.listInbound({
            endpointId: 'ep',
            recent: true,
            readyOnly: true,
            limit: 1
          })
        ).map((record) => record.snapshot.requestId)
      ).toEqual(['ready'])
      expect(
        (await storage.listPendingInbound({ ...pending, limit: 1 })).map(
          (record) => record.snapshot.requestId
        )
      ).toEqual(['ready'])
      expect(await storage.listInbound({ limit: 10 })).toHaveLength(2)
    })

    it('persists derived results without changing raw content, fences settlement and redacts middleware outputs with messages', async () => {
      const work = required((await storage.takeDue(scan))[0])
      expect(work.kind).toBe('prepare')
      expect(
        await storage.settleAttempt({
          kind: 'dispatch',
          id: 'r1',
          lease: work.lease,
          outcome: { status: 'accepted' },
          nextDueAt: 101,
          now: 101
        })
      ).toEqual({ status: 'conflict' })
      expect(
        await storage.settleAttempt({
          kind: 'prepare',
          id: 'r1',
          lease: work.lease,
          outcome: { status: 'prepared', preparation: [] },
          now: 101
        })
      ).toEqual({ status: 'conflict' })

      const settlement = {
        kind: 'prepare' as const,
        id: 'r1',
        lease: work.lease,
        outcome: {
          status: 'prepared' as const,
          preparation: [
            {
              id: 'prefix',
              status: 'completed' as const,
              output: {
                text: 'private derived text',
                data: { detail: 'private metadata' }
              }
            }
          ]
        },
        now: 101
      }

      expect(await storage.settleAttempt(settlement)).toMatchObject({
        status: 'updated'
      })
      expect(await storage.settleAttempt(settlement)).toEqual({
        status: 'conflict'
      })
      const prepared = required(await storage.getInbound('r1'))
      expect(prepared.snapshot).toEqual(input)
      expect(prepared.dispatch.attempts).toBe(0)
      expect(prepared.preparation).toEqual(settlement.outcome.preparation)
      expect(await storage.listPendingInbound(pending)).toHaveLength(1)

      const dispatch = required(
        (await storage.takeDue({ ...scan, now: 102 }))[0]
      )

      expect(dispatch.kind).toBe('dispatch')
      expect(
        await storage.settleAttempt({
          kind: 'prepare',
          id: 'r1',
          lease: dispatch.lease,
          outcome: settlement.outcome,
          now: 103
        })
      ).toEqual({ status: 'conflict' })
      expect(
        await storage.settleAttempt({
          kind: 'dispatch',
          id: 'r1',
          lease: dispatch.lease,
          outcome: { status: 'accepted' },
          nextDueAt: 103,
          now: 103
        })
      ).toMatchObject({ status: 'updated' })
      const before = Date.now() + 1000
      await storage.cleanup({ before, limit: 10 })
      expect(await storage.getInbound('r1')).toMatchObject({
        snapshot: { text: '', attachments: [] },
        preparation: [],
        redactedAt: before
      })
      expect(await storage.media?.get('channel', 'voice')).toBeUndefined()
    })

    it('falls back after an expired middleware lease without repeating processing or confusing dispatch expiry', async () => {
      const first = required((await storage.takeDue(scan))[0])
      expect(first.kind).toBe('prepare')
      expect(await storage.takeDue({ ...scan, now: 150 })).toEqual([])

      const recovered = required(
        (await storage.takeDue({ ...scan, now: 201 }))[0]
      )

      expect(recovered.kind).toBe('dispatch')
      expect(await storage.getInbound('r1')).toMatchObject({
        snapshot: input,
        preparation: [
          { id: 'prefix', status: 'failed', errorCode: 'interrupted' }
        ],
        dispatch: { status: 'due', attempts: 0 }
      })
      expect(
        await storage.settleAttempt({
          kind: 'prepare',
          id: 'r1',
          lease: first.lease,
          outcome: {
            status: 'prepared',
            preparation: [
              { id: 'prefix', status: 'completed', output: { text: 'late' } }
            ]
          },
          now: 202
        })
      ).toEqual({ status: 'conflict' })
      expect(await storage.takeDue({ ...scan, now: 302 })).toEqual([])
      expect(await storage.getInbound('r1')).toMatchObject({
        dispatch: { status: 'unknown', errorCode: 'lease_expired' }
      })
      expect((await storage.media?.get('channel', 'voice'))?.data).toEqual(
        audio.data
      )
    })
  })
}
