import { createHash } from 'node:crypto'
import type {
  EnqueueMessageInput,
  Storage,
  StoredMedia
} from '../../packages/sdk/src/index.js'
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

const messageWithMedia = (
  messageId: string,
  assets: readonly StoredMedia[]
): EnqueueMessageInput => {
  const input = completion('r1', messageId)
  return {
    ...input,
    media: assets,
    message: {
      ...input.message,
      attachments: assets.map((item) => item.reference)
    },
    outbound: {
      ...input.outbound,
      chunks: [
        ...input.outbound.chunks,
        ...assets.map((item) => ({
          text: '',
          media: item.reference,
          state: null,
          idempotencyKey: item.reference.id
        }))
      ]
    }
  }
}

export function mediaContract(
  name: string,
  open: () => Promise<Storage>
): void {
  describe(name, () => {
    it('stages immutable request-owned assets, rejects foreign ownership and serializes cumulative upload budgets', async () => {
      const s = await open()
      try {
        await s.initialize()
        const incoming = asset('incoming', [7])
        await s.acceptInbound(
          { ...snapshot(), attachments: [incoming.reference] },
          [incoming]
        )
        const media = required(s.media)

        const input = {
          requestId: 'r1',
          agent: 'grok' as const,
          endpointIds: ['ep'],
          media: asset('staged'),
          maxBytes: 3,
          maxCount: 3,
          maxTotalBytes: 5
        }

        for (const change of [
          { requestId: 'missing' },
          { agent: 'dot' as const },
          { endpointIds: ['foreign'] }
        ]) {
          expect(await media.put({ ...input, ...change })).toEqual({
            status: 'unauthorized'
          })
        }
        expect(await media.get('r1', 'staged')).toBeUndefined()
        expect(await media.put(input)).toEqual({
          status: 'stored',
          reference: input.media.reference
        })
        expect(
          await media.put({ ...input, maxCount: 0, maxTotalBytes: 0 })
        ).toEqual({ status: 'stored', reference: input.media.reference })
        expect(
          await media.put({ ...input, media: asset('staged', [1]) })
        ).toEqual({ status: 'conflict' })
        expect(
          await media.put({
            ...input,
            media: {
              ...input.media,
              reference: { ...input.media.reference, fileName: 'changed.png' }
            }
          })
        ).toEqual({ status: 'conflict' })

        const raced = await Promise.all(
          ['one', 'two'].map(async (id) =>
            media.put({ ...input, media: asset(id, [1]) })
          )
        )

        expect(
          raced.filter((result) => result.status === 'stored')
        ).toHaveLength(1)
        expect(
          raced.filter((result) => result.status === 'too_many_attachments')
        ).toHaveLength(1)
        expect(
          await media.put({
            ...input,
            maxCount: 4,
            media: asset('overflow', [1])
          })
        ).toEqual({ status: 'media_total_too_large' })
        expect(
          await media.put({
            ...input,
            maxCount: 4,
            maxTotalBytes: 10,
            media: asset('large', [1, 2, 3, 4])
          })
        ).toEqual({ status: 'media_too_large' })
        expect(await media.get('r1', 'overflow')).toBeUndefined()
        expect(await media.get('r1', 'large')).toBeUndefined()
        expect(await media.get('r1', 'staged')).toEqual(input.media)
        await s.acceptInbound(snapshot('r2', 101))
        expect(await media.put({ ...input, requestId: 'r2' })).toEqual({
          status: 'conflict'
        })
      } finally {
        await s.close()
      }
    })

    it('requires available request-owned image previews and removes staged bytes on redaction', async () => {
      const s = await open()
      try {
        await s.initialize()
        await s.acceptInbound(snapshot())
        const media = required(s.media)
        const preview = asset('preview')

        const video = {
          ...asset('video'),
          reference: {
            ...asset('video').reference,
            kind: 'video' as const,
            mimeType: 'video/mp4',
            previewMediaId: 'preview'
          }
        }

        const input = {
          requestId: 'r1',
          agent: 'grok' as const,
          endpointIds: ['ep'],
          media: video,
          maxBytes: 3,
          maxCount: 3,
          maxTotalBytes: 9
        }

        expect(await media.put(input)).toEqual({
          status: 'invalid_media_preview'
        })
        expect(await media.get('r1', 'video')).toBeUndefined()
        expect(await media.put({ ...input, media: preview })).toMatchObject({
          status: 'stored'
        })
        expect(await media.put(input)).toMatchObject({ status: 'stored' })

        const work = required(
          (
            await s.takeDue({
              now: 100,
              leaseMs: 20,
              limit: 1,
              leaseOwner: 'worker',
              safeRetryAccountIds: []
            })
          )[0]
        )

        await s.settleAttempt({
          kind: 'dispatch',
          id: 'r1',
          lease: work.lease,
          outcome: { status: 'accepted' },
          now: 101,
          nextDueAt: 101
        })
        expect(await s.cleanup({ before: 200, limit: 10 })).toEqual({
          redacted: 1
        })
        expect(await media.get('r1', 'preview')).toBeUndefined()
        expect(await media.get('r1', 'video')).toBeUndefined()
        expect(await media.put(input)).toEqual({ status: 'unauthorized' })
      } finally {
        await s.close()
      }
    })

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

    it('atomically budgets input plus outgoing bytes, reuses existing assets and serializes competing messages', async () => {
      const s = await open()
      try {
        await s.initialize()
        const media = required(s.media)
        const incoming = asset('incoming')
        await s.acceptInbound(
          { ...snapshot(), attachments: [incoming.reference] },
          [incoming]
        )
        const first = asset('first')

        const input = {
          ...messageWithMedia('first', [first]),
          maxCount: 2,
          maxTotalBytes: 6
        }

        const raced = await Promise.all([
          s.enqueueMessage(input),
          s.enqueueMessage(input)
        ])

        expect(raced).toEqual(
          expect.arrayContaining([
            {
              status: 'queued',
              deliveryId: input.outbound.deliveryId,
              replay: false
            },
            {
              status: 'queued',
              deliveryId: input.outbound.deliveryId,
              replay: true
            }
          ])
        )
        expect(
          await s.enqueueMessage({ ...input, maxCount: 0, maxTotalBytes: 0 })
        ).toMatchObject({ status: 'queued', replay: true })
        expect(
          await s.enqueueMessage({
            ...messageWithMedia('overflow', [asset('overflow', [1])]),
            maxCount: 3,
            maxTotalBytes: 6
          })
        ).toEqual({ status: 'conflict' })
        expect(await media.get('r1', 'overflow')).toBeUndefined()

        const competing = await Promise.all(
          ['one', 'two'].map(async (id) =>
            s.enqueueMessage({
              ...messageWithMedia(id, [asset(id, [1])]),
              maxCount: 3,
              maxTotalBytes: 7
            })
          )
        )

        expect(
          competing.filter((result) => result.status === 'queued')
        ).toHaveLength(1)
        expect(
          competing.filter((result) => result.status === 'conflict')
        ).toHaveLength(1)
        expect(
          await s.enqueueMessage({
            ...messageWithMedia('reuse', [first]),
            maxCount: 3,
            maxTotalBytes: 7
          })
        ).toMatchObject({ status: 'queued' })
      } finally {
        await s.close()
      }
    })

    it('rejects foreign assets, metadata changes, unreferenced bytes and mismatched ordered chunks before any asset write', async () => {
      const s = await open()
      try {
        await s.initialize()
        await s.acceptInbound(snapshot())
        const foreign = asset('foreign')
        await s.acceptInbound(
          { ...snapshot('r2', 101, 'ep2'), attachments: [foreign.reference] },
          [foreign]
        )
        expect(
          await s.enqueueMessage(messageWithMedia('foreign', [foreign]))
        ).toEqual({ status: 'conflict' })
        const newAsset = asset('new')
        const input = messageWithMedia('new', [newAsset])
        for (const change of [
          { endpointIds: ['ep2'] },
          { agent: 'dot' as const }
        ]) {
          expect(await s.enqueueMessage({ ...input, ...change })).toEqual({
            status: 'unauthorized'
          })
        }
        expect(await required(s.media).get('r1', 'new')).toBeUndefined()
        expect(
          await s.enqueueMessage({
            ...input,
            media: [{ ...newAsset, data: new Uint8Array([1]) }]
          })
        ).toEqual({ status: 'conflict' })
        expect(
          await s.enqueueMessage({
            ...input,
            media: [newAsset, asset('extra')]
          })
        ).toEqual({ status: 'conflict' })
        expect(
          await s.enqueueMessage({ ...input, outbound: completion().outbound })
        ).toEqual({ status: 'conflict' })
        expect(await s.enqueueMessage(input)).toMatchObject({
          status: 'queued'
        })
        for (const metadata of [
          { durationMs: 1500 },
          { previewMediaId: 'preview' },
          { fileName: 'forged.png' }
        ]) {
          const changed = {
            ...newAsset,
            reference: { ...newAsset.reference, ...metadata }
          }

          expect(
            await s.enqueueMessage(messageWithMedia('changed', [changed]))
          ).toEqual({ status: 'conflict' })
        }
      } finally {
        await s.close()
      }
    })

    it('commits a generated video with its native image preview and retains bytes through ambiguous delivery recovery', async () => {
      const s = await open()
      try {
        await s.initialize()
        await s.acceptInbound(snapshot())

        const dispatch = required(
          (
            await s.takeDue({
              now: 100,
              leaseMs: 10,
              limit: 10,
              leaseOwner: 'worker',
              safeRetryAccountIds: []
            })
          )[0]
        )

        await s.settleAttempt({
          kind: 'dispatch',
          id: 'r1',
          lease: dispatch.lease,
          outcome: { status: 'accepted' },
          now: 101,
          nextDueAt: 101
        })
        const preview = asset('preview')

        const video = {
          ...asset('video'),
          reference: {
            ...asset('video').reference,
            kind: 'video' as const,
            mimeType: 'video/mp4',
            previewMediaId: 'preview'
          }
        }

        const input = {
          ...messageWithMedia('video', [video]),
          media: [video, preview]
        }

        expect(await s.enqueueMessage({ ...input, media: [video] })).toEqual({
          status: 'conflict'
        })
        expect(
          await s.enqueueMessage({
            ...input,
            media: [
              video,
              {
                ...preview,
                reference: { ...preview.reference, previewMediaId: 'video' }
              }
            ]
          })
        ).toEqual({ status: 'conflict' })
        expect(await s.enqueueMessage(input)).toMatchObject({
          status: 'queued',
          replay: false
        })
        expect(await required(s.media).get('r1', 'preview')).toEqual(preview)

        const due = async (): ReturnType<Storage['takeDue']> =>
          s.takeDue({
            now: 110,
            leaseMs: 20,
            limit: 10,
            leaseOwner: 'worker',
            safeRetryAccountIds: []
          })

        const uncertain = required((await due())[0])
        await s.settleAttempt({
          kind: 'send',
          id: input.outbound.deliveryId,
          lease: uncertain.lease,
          outcome: { status: 'unknown', errorCode: 'timeout' },
          now: 111,
          nextDueAt: 110
        })
        expect(await s.cleanup({ before: 200, limit: 10 })).toEqual({
          redacted: 0
        })
        expect(await required(s.media).get('r1', 'video')).toEqual(video)
        const record = required(await s.getOutbound(input.outbound.deliveryId))
        await s.requeue({
          kind: 'delivery',
          id: record.deliveryId,
          expectedVersion: record.version,
          now: 110,
          acknowledgeUnknown: true
        })
        for (let index = 0; index < 3; index++) {
          const work = required((await due())[0])
          await s.settleAttempt({
            kind: 'send',
            id: record.deliveryId,
            lease: work.lease,
            outcome: { status: 'sent', receipt: {} },
            now: 111,
            nextDueAt: 110
          })
        }
        expect(await s.cleanup({ before: 200, limit: 10 })).toEqual({
          redacted: 1
        })
        expect(await required(s.media).get('r1', 'video')).toBeUndefined()
        expect(await required(s.media).get('r1', 'preview')).toBeUndefined()
        expect(await s.enqueueMessage(input)).toMatchObject({
          status: 'queued',
          replay: true
        })
      } finally {
        await s.close()
      }
    })
  })
}
