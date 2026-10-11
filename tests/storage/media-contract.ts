import { createHash } from 'node:crypto'
import type { Storage, StoredMedia } from '../../packages/sdk/src/index.js'
import { describe, it, expect } from 'vitest'
import {
  snapshot,
  completion,
  required
} from '../contracts/storage-contract.js'

export const asset = (id = 'asset', bytes = [0, 255, 10]): StoredMedia => {
  const data = new Uint8Array(bytes)
  return {
    data,
    reference: {
      id,
      kind: 'image',
      mimeType: 'image/png',
      fileName: 'image.png',
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex')
    }
  }
}

export function mediaContract(name: string, open: () => Promise<Storage>) {
  describe(name, () => {
    it('commits input bytes with snapshots, deduplicates without orphan assets and rejects invalid metadata atomically', async () => {
      const s = await open()
      try {
        await s.initialize()
        const media = required(s.media)
        const incoming = asset()
        await s.acceptInbound(
          { ...snapshot(), attachments: [incoming.reference] },
          [incoming]
        )
        expect(await media.get('r1', 'asset')).toEqual(incoming)
        expect(await media.get('other', 'asset')).toBeUndefined()
        const duplicate = asset('duplicate')
        expect(
          await s.acceptInbound(
            {
              ...snapshot('duplicate-request'),
              source: snapshot().source,
              attachments: [duplicate.reference]
            },
            [duplicate]
          )
        ).toEqual({ requestId: 'r1', duplicate: true })
        expect(
          await media.get('duplicate-request', 'duplicate')
        ).toBeUndefined()
        await expect(
          s.acceptInbound(
            { ...snapshot('bad'), attachments: [incoming.reference] },
            [{ ...incoming, data: new Uint8Array([1]) }]
          )
        ).rejects.toThrow()
        expect(await s.getInbound('bad')).toBeUndefined()
        await expect(
          s.acceptInbound(
            { ...snapshot('collision'), attachments: [incoming.reference] },
            [incoming]
          )
        ).rejects.toThrow()
        expect(await s.getInbound('collision')).toBeUndefined()
      } finally {
        await s.close()
      }
    })

    it('applies aggregate inbound and upload budgets atomically while allowing replay at the limit', async () => {
      const s = await open()
      try {
        await s.initialize()
        const media = required(s.media)
        const incoming = asset('incoming')
        await s.acceptInbound(
          { ...snapshot(), attachments: [incoming.reference] },
          [incoming]
        )

        const claim = {
          requestId: 'r1',
          agent: 'grok' as const,
          endpointIds: ['ep'],
          claimToken: 'token'
        }

        await s.claimRequest({ ...claim, claimKey: 'key', now: 105 })
        const first = asset('first')
        const put = { ...claim, maxCount: 2, maxTotalBytes: 6, media: first }
        const raced = await Promise.all([media.put(put), media.put(put)])
        expect(raced).toEqual(
          expect.arrayContaining([
            { status: 'stored', media: first.reference, replay: false },
            { status: 'stored', media: first.reference, replay: true }
          ])
        )
        expect(
          await media.put({ ...put, maxCount: 0, maxTotalBytes: 0 })
        ).toEqual({
          status: 'stored',
          media: first.reference,
          replay: true
        })
        expect(
          await media.put({
            ...put,
            maxCount: 3,
            media: asset('bytes-overflow', [1])
          })
        ).toEqual({ status: 'conflict' })
        expect(
          await media.put({
            ...put,
            maxTotalBytes: 20,
            media: asset('count-overflow', [1])
          })
        ).toEqual({ status: 'conflict' })
        expect(await media.get('r1', 'bytes-overflow')).toBeUndefined()
        expect(await media.get('r1', 'count-overflow')).toBeUndefined()

        const competing = await Promise.all([
          media.put({
            ...put,
            maxCount: 3,
            maxTotalBytes: 7,
            media: asset('race-one', [1])
          }),
          media.put({
            ...put,
            maxCount: 3,
            maxTotalBytes: 7,
            media: asset('race-two', [2])
          })
        ])

        expect(
          competing.filter((result) => result.status === 'stored')
        ).toHaveLength(1)
        expect(
          competing.filter((result) => result.status === 'conflict')
        ).toHaveLength(1)
      } finally {
        await s.close()
      }
    })

    it('fences uploads, enforces request ownership and binds completion and retention to ordered media', async () => {
      const s = await open()
      try {
        await s.initialize()
        const media = required(s.media)
        await s.acceptInbound(snapshot())
        await s.acceptInbound(snapshot('r2', 101, 'ep2'))

        const claim = {
          requestId: 'r1',
          agent: 'grok' as const,
          endpointIds: ['ep'],
          claimToken: 'token'
        }

        await s.claimRequest({ ...claim, claimKey: 'key', now: 105 })
        await s.claimRequest({
          ...claim,
          requestId: 'r2',
          endpointIds: ['ep2'],
          claimKey: 'key2',
          now: 105
        })
        const incoming = asset()
        expect(
          await media.put({ ...claim, claimToken: 'stale', media: incoming })
        ).toEqual({
          status: 'unauthorized'
        })
        expect(await media.get('r1', 'asset')).toBeUndefined()
        expect(
          await media.put({ ...claim, endpointIds: ['ep2'], media: incoming })
        ).toEqual({
          status: 'unauthorized'
        })
        expect(
          await media.put({ ...claim, agent: 'dot', media: incoming })
        ).toEqual({
          status: 'unauthorized'
        })
        expect(await media.put({ ...claim, media: incoming })).toEqual({
          status: 'stored',
          media: incoming.reference,
          replay: false
        })
        expect(await media.put({ ...claim, media: incoming })).toEqual({
          status: 'stored',
          media: incoming.reference,
          replay: true
        })
        for (const metadata of [
          { durationMs: 1500 },
          { previewMediaId: 'preview' }
        ]) {
          expect(
            await media.put({
              ...claim,
              media: {
                ...incoming,
                reference: { ...incoming.reference, ...metadata }
              }
            })
          ).toEqual({ status: 'conflict' })
        }
        expect(
          await media.put({ ...claim, media: asset('asset', [1, 2]) })
        ).toEqual({
          status: 'conflict'
        })
        expect(
          await media.put({
            ...claim,
            requestId: 'r2',
            endpointIds: ['ep2'],
            media: incoming
          })
        ).toEqual({ status: 'conflict' })
        const foreign = asset('foreign')
        await media.put({
          ...claim,
          requestId: 'r2',
          endpointIds: ['ep2'],
          media: foreign
        })
        const second = asset('second')
        await media.put({ ...claim, media: second })
        const original = completion()

        const withMedia = {
          ...original,
          result: {
            ...original.result,
            attachments: [incoming.reference, second.reference]
          },
          outbound: {
            ...original.outbound,
            chunks: [
              ...original.outbound.chunks,
              {
                text: '',
                media: incoming.reference,
                state: null,
                idempotencyKey: 'media'
              },
              {
                text: '',
                media: second.reference,
                state: null,
                idempotencyKey: 'second'
              }
            ]
          }
        }

        expect(
          await s.completeAndEnqueue({
            ...withMedia,
            result: { ...withMedia.result, attachments: [foreign.reference] },
            outbound: {
              ...withMedia.outbound,
              chunks: [
                { text: 'AB', state: null, idempotencyKey: 'x' },
                {
                  text: '',
                  media: foreign.reference,
                  state: null,
                  idempotencyKey: 'y'
                }
              ]
            }
          })
        ).toEqual({ status: 'conflict' })
        expect(
          await s.completeAndEnqueue({
            ...withMedia,
            outbound: original.outbound
          })
        ).toEqual({
          status: 'conflict'
        })
        expect(
          await s.completeAndEnqueue({
            ...withMedia,
            result: {
              ...withMedia.result,
              attachments: [second.reference, incoming.reference]
            }
          })
        ).toEqual({ status: 'conflict' })
        expect(
          await s.completeAndEnqueue({
            ...withMedia,
            result: {
              ...withMedia.result,
              attachments: [
                { ...incoming.reference, fileName: 'forged.png' },
                second.reference
              ]
            }
          })
        ).toEqual({ status: 'conflict' })
        expect(await s.completeAndEnqueue(withMedia)).toMatchObject({
          status: 'completed',
          replay: false
        })
        expect(await s.completeAndEnqueue(withMedia)).toMatchObject({
          status: 'completed',
          replay: true
        })
        expect(await s.completeAndEnqueue(original)).toEqual({
          status: 'conflict'
        })
        expect(await s.cleanup({ before: 200, limit: 10 })).toEqual({
          redacted: 0
        })
        expect(await media.get('r1', 'asset')).toEqual(incoming)

        const uncertain = required(
          (
            await s.takeDue({
              now: 110,
              leaseMs: 20,
              limit: 10,
              leaseOwner: 'worker',
              safeRetryAccountIds: []
            })
          ).find((item) => item.kind === 'send')
        )

        await s.settleAttempt({
          kind: 'send',
          id: 'd-r1',
          lease: uncertain.lease,
          outcome: { status: 'unknown', errorCode: 'timeout' },
          nextDueAt: 110,
          now: 111
        })
        expect(await s.cleanup({ before: 200, limit: 10 })).toEqual({
          redacted: 0
        })
        expect(await media.get('r1', 'asset')).toEqual(incoming)
        const unknownDelivery = required(await s.getOutbound('d-r1'))
        await s.requeue({
          kind: 'delivery',
          id: 'd-r1',
          expectedVersion: unknownDelivery.version,
          now: 110,
          acknowledgeUnknown: true
        })
        for (let index = 0; index < 4; index++) {
          const work = required(
            (
              await s.takeDue({
                now: 110,
                leaseMs: 20,
                limit: 10,
                leaseOwner: 'worker',
                safeRetryAccountIds: []
              })
            ).find((item) => item.kind === 'send')
          )

          await s.settleAttempt({
            kind: 'send',
            id: 'd-r1',
            lease: work.lease,
            outcome: { status: 'sent', receipt: {} },
            nextDueAt: 110,
            now: 111
          })
        }
        expect(await s.cleanup({ before: 200, limit: 10 })).toEqual({
          redacted: 1
        })
        expect(await media.get('r1', 'asset')).toBeUndefined()
        expect((await s.getInbound('r1'))?.snapshot.attachments).toEqual([])
        expect((await s.getInbound('r1'))?.result?.attachments).toEqual([])
        expect(
          (await s.getOutbound('d-r1'))?.chunks.some((chunk) => chunk.media)
        ).toBe(false)
        expect(await s.completeAndEnqueue(withMedia)).toMatchObject({
          status: 'completed',
          replay: true
        })
        expect(
          await media.put({
            ...claim,
            requestId: 'r2',
            endpointIds: ['ep2'],
            media: incoming
          })
        ).toEqual({ status: 'conflict' })
      } finally {
        await s.close()
      }
    })
  })
}
