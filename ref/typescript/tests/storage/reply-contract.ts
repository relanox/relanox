import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type {
  EnqueueMessageInput,
  Storage
} from '../../packages/sdk/src/index.js'
import {
  completion,
  required,
  snapshot,
  testConversations
} from '../contracts/storage-contract.js'

function reply(
  requestId: string,
  kind: 'progress' | 'final',
  key: string
): EnqueueMessageInput {
  const input = completion('channel', key)
  const reference = { requestId, kind }
  return {
    ...input,
    message: { ...input.message, reply: reference },
    outbound: { ...input.outbound, reply: reference }
  }
}

export function replyContract(
  name: string,
  open: () => Promise<Storage>
): void {
  describe(name, () => {
    let storage: Storage
    beforeEach(async () => {
      storage = await open()
      await storage.initialize()
      await storage.registerConversations(testConversations)
      await storage.acceptInbound(snapshot())
    })
    afterEach(async () => storage.close())

    it('atomically correlates one final even with concurrent different send keys, rejecting changed replies and cross-channel requests', async () => {
      await storage.acceptInbound(snapshot('foreign', 100, 'other'))
      expect(
        await storage.enqueueMessage(reply('foreign', 'final', 'foreign'))
      ).toEqual({ status: 'not_found' })
      expect(
        await storage.enqueueMessage(reply('missing', 'final', 'missing'))
      ).toEqual({ status: 'not_found' })
      await storage.enqueueMessage(reply('r1', 'progress', 'progress'))
      expect((await storage.getInbound('r1'))?.reply).toEqual({})

      const [first, retry] = await Promise.all([
        storage.enqueueMessage(reply('r1', 'final', 'first')),
        storage.enqueueMessage(reply('r1', 'final', 'another-key'))
      ])

      expect(first.status).toBe('queued')
      expect(retry.status).toBe('queued')
      if (first.status !== 'queued' || retry.status !== 'queued') {
        throw new Error('Missing final receipt')
      }
      expect(first.deliveryId).toBe(retry.deliveryId)
      expect(
        [first.replay, retry.replay].toSorted((a, b) => Number(a) - Number(b))
      ).toEqual([false, true])
      expect((await storage.getInbound('r1'))?.reply).toEqual({
        finalDeliveryId: first.deliveryId
      })
      expect(await storage.listOutbound({ limit: 10 })).toHaveLength(2)
      const changed = reply('r1', 'final', 'changed')
      expect(
        await storage.enqueueMessage({
          ...changed,
          message: { ...changed.message, text: 'different' }
        })
      ).toEqual({ status: 'conflict' })
      expect(
        await storage.getMessageReceipt(reply('r1', 'final', 'fresh-key'))
      ).toEqual({
        status: 'queued',
        deliveryId: first.deliveryId,
        replay: true
      })
    })

    it('pages retained unfinished requests oldest first across completion, excluding other or inactive channels', async () => {
      await storage.acceptInbound(snapshot('z-old', 90))
      await storage.acceptInbound(snapshot('a-tie', 100))
      await storage.acceptInbound(snapshot('b-tie', 100))
      await storage.acceptInbound(snapshot('foreign', 50, 'other'))
      await storage.acceptInbound(snapshot('inactive', 50, 'ep', 'independent'))
      await storage.registerConversations(
        testConversations.filter(
          (record) => record.address.id !== 'independent'
        )
      )

      const query = {
        channelIds: ['channel', 'independent'],
        endpointIds: ['ep'],
        limit: 2
      }

      const first = await storage.listPendingInbound(query)
      expect(first.map((record) => record.snapshot.requestId)).toEqual([
        'z-old',
        'a-tie'
      ])
      expect((await storage.getInbound('a-tie'))?.dispatch).toEqual({
        status: 'due',
        attempts: 0,
        dueAt: 100
      })
      const final = reply('z-old', 'final', 'finished')
      await storage.enqueueMessage(final)
      // Complete both public delivery chunks between pages; an offset cursor would skip work.
      for (let chunk = 0; chunk < 2; chunk++) {
        const work = required(
          (
            await storage.takeDue({
              now: 110,
              leaseMs: 100,
              limit: 20,
              leaseOwner: 'worker',
              safeRetryAccountIds: []
            })
          ).find((item) => item.kind === 'send')
        )

        expect(
          await storage.settleAttempt({
            kind: 'send',
            id: final.outbound.deliveryId,
            lease: work.lease,
            now: 111,
            nextDueAt: 110,
            outcome: {
              status: 'sent',
              receipt: { platformMessageId: String(chunk) }
            }
          })
        ).toMatchObject({ status: 'updated' })
      }

      const next = await storage.listPendingInbound({
        ...query,
        cursor: { acceptedAt: 100, requestId: 'a-tie' }
      })

      expect(next.map((record) => record.snapshot.requestId)).toEqual([
        'b-tie',
        'r1'
      ])
      expect(
        await storage.listPendingInbound({
          ...query,
          cursor: { acceptedAt: 100, requestId: 'r1' }
        })
      ).toEqual([])
      expect(
        (await storage.listPendingInbound(query)).map(
          (record) => record.snapshot.requestId
        )
      ).toEqual(['a-tie', 'b-tie'])
      expect(
        await storage.listPendingInbound({ ...query, endpointIds: ['other'] })
      ).toEqual([])
    })

    it('retains ambiguous finals for delivery recovery and refuses to notify their source again', async () => {
      const dispatch = required(
        (
          await storage.takeDue({
            now: 100,
            leaseMs: 100,
            limit: 1,
            leaseOwner: 'worker',
            safeRetryAccountIds: []
          })
        )[0]
      )

      await storage.settleAttempt({
        kind: 'dispatch',
        id: 'r1',
        lease: dispatch.lease,
        now: 101,
        nextDueAt: 101,
        outcome: { status: 'accepted' }
      })
      const final = reply('r1', 'final', 'ambiguous')
      await storage.enqueueMessage(final)

      const work = required(
        (
          await storage.takeDue({
            now: 110,
            leaseMs: 100,
            limit: 1,
            leaseOwner: 'worker',
            safeRetryAccountIds: []
          })
        )[0]
      )

      await storage.settleAttempt({
        kind: 'send',
        id: final.outbound.deliveryId,
        lease: work.lease,
        now: 111,
        nextDueAt: 111,
        outcome: { status: 'unknown', errorCode: 'timeout' }
      })
      const source = required(await storage.getInbound('r1'))
      expect(
        await storage.listPendingInbound({
          channelIds: ['channel'],
          endpointIds: ['ep'],
          limit: 5
        })
      ).toMatchObject([
        {
          snapshot: { requestId: 'r1' },
          reply: { finalDeliveryId: final.outbound.deliveryId }
        }
      ])
      expect(
        await storage.requeue({
          kind: 'request',
          id: 'r1',
          expectedVersion: source.version,
          now: 112,
          acknowledgeUnknown: true
        })
      ).toEqual({ status: 'conflict' })

      const delivery = required(
        await storage.getOutbound(final.outbound.deliveryId)
      )

      expect(
        await storage.requeue({
          kind: 'delivery',
          id: delivery.deliveryId,
          expectedVersion: delivery.version,
          now: 112,
          acknowledgeUnknown: false
        })
      ).toEqual({ status: 'conflict' })
      expect(
        await storage.requeue({
          kind: 'delivery',
          id: delivery.deliveryId,
          expectedVersion: delivery.version,
          now: 112,
          acknowledgeUnknown: true
        })
      ).toMatchObject({ status: 'updated' })
      expect(
        await storage.enqueueMessage(reply('r1', 'final', 'new-key'))
      ).toEqual({
        status: 'queued',
        deliveryId: delivery.deliveryId,
        replay: true
      })
    })

    it('preserves an active notification lease when its final arrives before the webhook receipt', async () => {
      const work = required(
        (
          await storage.takeDue({
            now: 100,
            leaseMs: 20,
            limit: 1,
            leaseOwner: 'worker',
            safeRetryAccountIds: []
          })
        )[0]
      )

      expect(work.kind).toBe('dispatch')
      const queued = await storage.enqueueMessage(reply('r1', 'final', 'fast'))
      expect(queued.status).toBe('queued')
      expect(
        await storage.settleAttempt({
          kind: 'dispatch',
          id: 'r1',
          lease: work.lease,
          now: 110,
          nextDueAt: 110,
          outcome: { status: 'accepted' }
        })
      ).toMatchObject({ status: 'updated' })
      expect((await storage.getInbound('r1'))?.dispatch.status).toBe('accepted')
      expect((await storage.getInbound('r1'))?.reply?.finalDeliveryId).toBe(
        'd-channel-fast'
      )
      expect(
        await storage.settleAttempt({
          kind: 'dispatch',
          id: 'r1',
          lease: work.lease,
          now: 111,
          nextDueAt: 111,
          outcome: { status: 'rejected', errorCode: 'late' }
        })
      ).toEqual({ status: 'conflict' })
    })
  })
}
