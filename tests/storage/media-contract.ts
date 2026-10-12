import { createHash } from 'node:crypto'
import type {
  EnqueueMessageInput,
  Storage,
  StoredMedia
} from '../../packages/sdk/src/index.js'
import { describe, it, expect, vi } from 'vitest'
import {
  snapshot,
  testConversations,
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
  const input = completion('channel', messageId)
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
    it('reclaims abandoned staged uploads past protected pending assets and restores outstanding quotas', async () => {
      const s = await open()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
      try {
        await s.initialize()
        await s.registerConversations(testConversations)
        const pending = asset('pending')
        expect(
          await s.enqueueMessage(messageWithMedia('pending', [pending]))
        ).toMatchObject({ status: 'queued' })
        clock.mockReturnValue(200)
        const media = required(s.media)

        const upload = {
          channelId: 'channel',
          agent: 'grok' as const,
          endpointIds: ['ep'],
          media: asset('abandoned'),
          maxBytes: 3,
          maxCount: 1,
          maxTotalBytes: 3
        }

        expect(await media.put(upload)).toMatchObject({ status: 'stored' })
        expect(await media.put({ ...upload, media: asset('blocked') })).toEqual(
          { status: 'too_many_attachments' }
        )
        expect(await s.cleanup({ before: 300, limit: 1 })).toEqual({
          redacted: 0
        })
        expect(await media.get('channel', 'abandoned')).toBeUndefined()
        expect(await media.get('channel', 'pending')).toEqual(pending)
        expect((await s.getOutbound('d-channel-pending'))?.status).toBe(
          'pending'
        )
        expect(
          await media.put({ ...upload, media: asset('next') })
        ).toMatchObject({ status: 'stored' })
      } finally {
        clock.mockRestore()
        await s.close()
      }
    })

    it('retains an older image preview while a recent staged upload still references it', async () => {
      const s = await open()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
      try {
        await s.initialize()
        await s.registerConversations(testConversations)
        const media = required(s.media)

        const input = {
          channelId: 'channel',
          agent: 'grok' as const,
          endpointIds: ['ep'],
          media: asset('preview'),
          maxBytes: 3,
          maxCount: 2,
          maxTotalBytes: 6
        }

        expect(await media.put(input)).toMatchObject({ status: 'stored' })
        clock.mockReturnValue(200)

        const upload = {
          ...asset('video'),
          reference: {
            ...asset('video').reference,
            kind: 'video' as const,
            mimeType: 'video/mp4',
            previewMediaId: 'preview'
          }
        }

        expect(await media.put({ ...input, media: upload })).toMatchObject({
          status: 'stored'
        })
        expect(await s.cleanup({ before: 150, limit: 10 })).toEqual({
          redacted: 0
        })
        expect(await media.get('channel', 'preview')).toEqual(input.media)
        expect(await media.get('channel', 'video')).toEqual(upload)
        await s.cleanup({ before: 250, limit: 10 })
        expect(await media.get('channel', 'preview')).toBeUndefined()
        expect(await media.get('channel', 'video')).toBeUndefined()
        expect(
          await media.put({ ...input, media: asset('next') })
        ).toMatchObject({ status: 'stored' })
      } finally {
        clock.mockRestore()
        await s.close()
      }
    })

    it('stages immutable channel-owned assets, rejects foreign ownership and serializes outstanding upload budgets', async () => {
      const s = await open()
      try {
        await s.initialize()
        await s.registerConversations(testConversations)
        const incoming = asset('incoming', [7])
        await s.acceptInbound(
          { ...snapshot(), attachments: [incoming.reference] },
          [incoming]
        )
        const media = required(s.media)

        const input = {
          channelId: 'channel',
          agent: 'grok' as const,
          endpointIds: ['ep'],
          media: asset('staged'),
          maxBytes: 3,
          maxCount: 2,
          maxTotalBytes: 4
        }

        for (const change of [
          { channelId: 'missing' },
          { agent: 'dot' as const },
          { endpointIds: ['foreign'] }
        ]) {
          expect(await media.put({ ...input, ...change })).toEqual({
            status: 'unauthorized'
          })
        }
        expect(await media.get('channel', 'staged')).toBeUndefined()
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
        expect(await media.get('channel', 'overflow')).toBeUndefined()
        expect(await media.get('channel', 'large')).toBeUndefined()
        expect(await media.get('channel', 'staged')).toEqual(input.media)
        await s.acceptInbound(snapshot('r2', 101, 'ep2'))
        expect(
          await media.put({ ...input, channelId: 'ep2', endpointIds: ['ep2'] })
        ).toEqual({
          status: 'conflict'
        })
      } finally {
        await s.close()
      }
    })

    it('requires available channel-owned image previews and removes staged bytes on redaction', async () => {
      const s = await open()
      try {
        await s.initialize()
        await s.registerConversations(testConversations)
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
          channelId: 'channel',
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
        expect(await media.get('channel', 'video')).toBeUndefined()
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
        expect(await s.cleanup({ before: Date.now() + 1, limit: 10 })).toEqual({
          redacted: 1
        })
        expect(await media.get('channel', 'preview')).toBeUndefined()
        expect(await media.get('channel', 'video')).toBeUndefined()
        expect(await media.put(input)).toEqual({ status: 'conflict' })
      } finally {
        await s.close()
      }
    })

    it('commits input bytes with snapshots, deduplicates without orphan assets and rejects invalid metadata atomically', async () => {
      const s = await open()
      try {
        await s.initialize()
        await s.registerConversations(testConversations)
        const media = required(s.media)
        const incoming = asset()
        await s.acceptInbound(
          { ...snapshot(), attachments: [incoming.reference] },
          [incoming]
        )
        expect(await media.get('channel', 'asset')).toEqual(incoming)
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

    it('budgets each message graph independently, rejects oversized graphs and releases outstanding staged quotas at enqueue', async () => {
      const s = await open()
      try {
        await s.initialize()
        await s.registerConversations(testConversations)
        const media = required(s.media)

        const upload = {
          channelId: 'channel',
          agent: 'grok' as const,
          endpointIds: ['ep'],
          media: asset('first'),
          maxBytes: 3,
          maxCount: 1,
          maxTotalBytes: 3
        }

        expect(await media.put(upload)).toMatchObject({ status: 'stored' })
        expect(await media.put({ ...upload, media: asset('blocked') })).toEqual(
          { status: 'too_many_attachments' }
        )

        const first = {
          ...messageWithMedia('first', [upload.media]),
          maxCount: 1,
          maxTotalBytes: 3
        }

        const raced = await Promise.all([
          s.enqueueMessage(first),
          s.enqueueMessage(first)
        ])

        expect(raced).toEqual(
          expect.arrayContaining([
            {
              status: 'queued',
              deliveryId: first.outbound.deliveryId,
              replay: false
            },
            {
              status: 'queued',
              deliveryId: first.outbound.deliveryId,
              replay: true
            }
          ])
        )
        expect(
          await media.put({ ...upload, media: asset('next') })
        ).toMatchObject({ status: 'stored' })
        expect(
          await s.enqueueMessage({
            ...messageWithMedia('next', [asset('next')]),
            maxCount: 1,
            maxTotalBytes: 3
          })
        ).toMatchObject({ status: 'queued', replay: false })
        expect(
          await s.enqueueMessage({
            ...messageWithMedia('too-many', [asset('one'), asset('two')]),
            maxCount: 1,
            maxTotalBytes: 6
          })
        ).toEqual({ status: 'conflict' })
        expect(
          await s.enqueueMessage({
            ...messageWithMedia('too-large', [asset('large')]),
            maxCount: 1,
            maxTotalBytes: 2
          })
        ).toEqual({ status: 'conflict' })
        expect(await media.get('channel', 'one')).toBeUndefined()
        expect(await media.get('channel', 'large')).toBeUndefined()
        expect(
          await s.enqueueMessage({
            ...messageWithMedia('reuse', [upload.media]),
            maxCount: 1,
            maxTotalBytes: 3
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
        await s.registerConversations(testConversations)
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
        expect(await required(s.media).get('channel', 'new')).toBeUndefined()
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
        await s.registerConversations(testConversations)
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
        expect(await s.enqueueMessage({ ...input, maxCount: 1 })).toEqual({
          status: 'conflict'
        })
        expect(await s.enqueueMessage({ ...input, maxTotalBytes: 5 })).toEqual({
          status: 'conflict'
        })
        expect(await s.enqueueMessage(input)).toMatchObject({
          status: 'queued',
          replay: false
        })
        expect(await required(s.media).get('channel', 'preview')).toEqual(
          preview
        )

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
        expect(await s.cleanup({ before: Date.now() + 1, limit: 10 })).toEqual({
          redacted: 1
        })
        expect(await required(s.media).get('channel', 'video')).toEqual(video)
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
        expect(await s.cleanup({ before: Date.now() + 1, limit: 10 })).toEqual({
          redacted: 1
        })
        expect(await required(s.media).get('channel', 'video')).toBeUndefined()
        expect(
          await required(s.media).get('channel', 'preview')
        ).toBeUndefined()
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
