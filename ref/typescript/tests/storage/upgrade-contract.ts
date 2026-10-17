import { expect } from 'vitest'
import type { InboundRecord, Storage } from '../../packages/sdk/src/index.js'
import {
  required,
  snapshot,
  testConversations
} from '../contracts/storage-contract.js'

/** Seed the recorded pre-middleware JSON shape; both real databases run their public initializer. */
export async function verifySpeechUpgrade(
  storage: Storage,
  write: (record: InboundRecord) => Promise<void>
): Promise<void> {
  await storage.initialize()
  await storage.registerConversations(testConversations)
  for (const id of ['completed', 'waiting', 'interrupted']) {
    await storage.acceptInbound(snapshot(id))
    const record = required(await storage.getInbound(id))

    const legacy = {
      ...record,
      snapshot: {
        ...record.snapshot,
        speechToText: { provider: 'tencent', engine: '16k_zh' }
      },
      ...(id === 'completed'
        ? {
            transcriptions: [
              {
                mediaId: 'voice',
                status: 'transcribed',
                text: 'saved transcript'
              }
            ]
          }
        : {}),
      ...(id === 'interrupted'
        ? {
            dispatch: {
              ...record.dispatch,
              lease: {
                owner: 'old-worker',
                version: record.version,
                token: 'old-token',
                expiresAt: 101
              }
            }
          }
        : {})
    }

    await write(legacy)
  }
  await storage.initialize()
  const ready = required(await storage.getInbound('completed'))
  expect(ready.snapshot.text).toBe('question')
  expect(ready.snapshot).not.toHaveProperty('speechToText')
  expect(ready).not.toHaveProperty('transcriptions')
  expect(ready.preparation).toEqual([
    {
      id: 'speech-tencent',
      status: 'completed',
      output: {
        text: 'question\n\n[Voice transcript: voice]\nsaved transcript',
        data: {
          transcriptions: [
            {
              mediaId: 'voice',
              status: 'transcribed',
              text: 'saved transcript'
            }
          ]
        }
      }
    }
  ])
  expect(
    (await storage.listInbound({ limit: 10, readyOnly: true })).map(
      (record) => record.snapshot.requestId
    )
  ).toEqual(['completed'])
  await storage.initialize()
  expect(await storage.getInbound('completed')).toEqual(ready)

  const jobs = await storage.takeDue({
    now: 200,
    leaseMs: 100,
    leaseOwner: 'new-worker',
    limit: 10,
    safeRetryAccountIds: []
  })

  expect(
    jobs.map((job) => ({
      id:
        job.kind === 'send'
          ? job.record.deliveryId
          : job.record.snapshot.requestId,
      kind: job.kind
    }))
  ).toEqual([
    { id: 'completed', kind: 'dispatch' },
    { id: 'interrupted', kind: 'dispatch' },
    { id: 'waiting', kind: 'prepare' }
  ])
  expect((await storage.getInbound('waiting'))?.snapshot.middleware).toEqual([
    { id: 'speech-tencent', options: { engine: '16k_zh' } }
  ])
  expect((await storage.getInbound('interrupted'))?.preparation).toEqual([
    { id: 'speech-tencent', status: 'failed', errorCode: 'interrupted' }
  ])
}
