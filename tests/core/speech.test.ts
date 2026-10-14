import { expect, it, vi } from 'vitest'
import type {
  SpeechRecognition,
  SpeechToTextProvider
} from '../../packages/sdk/src/index.js'
import {
  projectAgentRequest,
  agentRequestSchema
} from '../../packages/agent-mcp/src/request-payload.js'
import { required } from '../contracts/storage-contract.js'
import { incoming, picture } from './fixture.js'
import { speechFixture } from './speech-fixture.js'

const audio = {
  kind: 'audio' as const,
  mimeType: 'audio/wav',
  fileName: 'voice.wav',
  data: new Uint8Array([1, 2, 3]),
  durationMs: 1000
}

function recognizer(
  recognize: SpeechToTextProvider['recognize']
): SpeechToTextProvider {
  return { provider: 'tencent', engine: '16k_zh', recognize }
}

it.each(['disabled', 'grok', 'image', 'video'] as const)(
  'does not transcribe for %s and preserves the original forwarding contract',
  async (mode) => {
    const call = vi.fn(async (): Promise<SpeechRecognition> => ({
      status: 'transcribed',
      text: 'unused'
    }))

    const fx = await speechFixture(
      mode === 'disabled' ? undefined : recognizer(call),
      mode === 'grok' ? 'grok' : 'dot'
    )

    try {
      const ordinary = mode === 'image' ? picture : audio

      const media =
        mode === 'video'
          ? {
              ...audio,
              kind: 'video' as const,
              mimeType: 'video/mp4',
              fileName: 'video.mp4'
            }
          : ordinary

      const receipt = await fx.channel.ingest({
        ...incoming,
        text: 'original',
        attachments: [media]
      })

      await fx.runtime.processDue()
      expect(call).not.toHaveBeenCalled()
      expect(fx.dispatched).toHaveLength(1)
      expect(fx.dispatched[0]?.text).toBe('original')
      expect(fx.dispatched[0]?.transcriptions).toBeUndefined()
      expect(fx.dispatched[0]?.attachments).toEqual(
        (await fx.storage.getInbound(receipt.requestId))?.snapshot.attachments
      )
    } finally {
      await fx.close()
    }
  }
)

it('acknowledges durable audio before recognition and exposes the same prepared text and metadata to notification and reads', async () => {
  let finish: ((result: SpeechRecognition) => void) | undefined

  const call = vi.fn(
    async () =>
      new Promise<SpeechRecognition>((resolve) => {
        finish = resolve
      })
  )

  const fx = await speechFixture(recognizer(call))
  try {
    const receipt = await fx.channel.ingest({
      ...incoming,
      text: 'original',
      attachments: [audio, picture]
    })

    expect(call).not.toHaveBeenCalled()
    expect(await fx.principal().readMessages({ pending: true })).toEqual([])
    expect(
      await fx.principal().readMessages({ requestId: receipt.requestId })
    ).toEqual([])
    expect(await fx.principal().readMessages({})).toEqual([])
    const raw = required(await fx.storage.getInbound(receipt.requestId))
    const id = required(raw.snapshot.attachments?.[0]).id
    expect(
      (await fx.storage.media?.get(raw.snapshot.channel.id, id))?.data
    ).toEqual(audio.data)
    const work = fx.runtime.processDue()
    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledOnce()
    })
    expect(fx.dispatched).toEqual([])
    expect(await fx.principal().readMessages({ pending: true })).toEqual([])
    required(finish)({ status: 'transcribed', text: '你好，明天见。' })
    await work
    const notification = required(fx.dispatched[0])
    expect(notification.text).toBe(
      `original\n\n[Voice transcript: ${id}]\n你好，明天见。`
    )
    expect(notification.attachments).toEqual(raw.snapshot.attachments)
    expect(notification.transcriptions).toEqual([
      { mediaId: id, status: 'transcribed', text: '你好，明天见。' }
    ])

    const read = required(
      (await fx.principal().readMessages({ requestId: receipt.requestId }))[0]
    )

    expect(projectAgentRequest(read)).toEqual(projectAgentRequest(notification))
    expect(
      agentRequestSchema.parse(projectAgentRequest(read)).transcriptions
    ).toEqual(notification.transcriptions)
    expect((await fx.storage.getInbound(receipt.requestId))?.snapshot).toEqual(
      raw.snapshot
    )
    expect(
      await fx.channel.ingest({
        ...incoming,
        text: 'duplicate',
        attachments: [audio]
      })
    ).toEqual({ requestId: receipt.requestId, duplicate: true })
    await fx.runtime.processDue()
    expect(call).toHaveBeenCalledOnce()
  } finally {
    await fx.close()
  }
})

it('reuses prepared recognition across notification retries, restart and explicit redispatch', async () => {
  const call = vi.fn(async (): Promise<SpeechRecognition> => ({
    status: 'transcribed',
    text: 'cached transcript'
  }))

  const fx = await speechFixture(recognizer(call))
  try {
    fx.setRetryDispatch(true)

    const receipt = await fx.channel.ingest({
      ...incoming,
      attachments: [audio]
    })

    await fx.runtime.processDue()
    expect(call).toHaveBeenCalledOnce()
    const runtime = await fx.restart()
    fx.setRetryDispatch(false)
    const record = required(await fx.storage.getInbound(receipt.requestId))
    const now = vi.spyOn(Date, 'now').mockReturnValue(record.dispatch.dueAt + 1)
    await runtime.processDue()
    now.mockRestore()
    expect(fx.dispatched).toHaveLength(2)
    const accepted = required(await fx.storage.getInbound(receipt.requestId))
    expect(
      await runtime.requeue({
        kind: 'request',
        id: receipt.requestId,
        expectedVersion: accepted.version,
        acknowledgeUnknown: false
      })
    ).toMatchObject({ status: 'updated' })
    await runtime.processDue()
    expect(call).toHaveBeenCalledOnce()
    expect(fx.dispatched).toHaveLength(3)
    expect(fx.dispatched[1]?.text).toBe(fx.dispatched[0]?.text)
    expect(fx.dispatched[1]?.transcriptions).toEqual([
      {
        mediaId: required(accepted.snapshot.attachments?.[0]).id,
        status: 'transcribed',
        text: 'cached transcript'
      }
    ])
  } finally {
    await fx.close()
  }
})

it.each(['failure', 'throw', 'invalid', 'timeout'] as const)(
  'falls back to original audio on %s without rejecting the message',
  async (mode) => {
    const provider = recognizer(async () => {
      if (mode === 'throw') {
        throw new Error('private provider exception')
      }
      if (mode === 'timeout') {
        return new Promise<SpeechRecognition>(() => {})
      }
      return mode === 'invalid'
        ? { status: 'transcribed', text: '' }
        : { status: 'failed', errorCode: 'recognition_failed' }
    })

    const fx = await speechFixture(provider)
    try {
      const receipt = await fx.channel.ingest({
        ...incoming,
        text: 'keep this',
        attachments: [audio]
      })

      if (mode === 'timeout') {
        vi.useFakeTimers()
      }
      const work = fx.runtime.processDue()
      if (mode === 'timeout') {
        await vi.advanceTimersByTimeAsync(10_001)
      }
      await work
      expect(fx.dispatched).toHaveLength(1)
      const record = required(await fx.storage.getInbound(receipt.requestId))
      expect(fx.dispatched[0]).toMatchObject({
        text: 'keep this',
        attachments: record.snapshot.attachments,
        transcriptions: [
          {
            status: 'failed',
            errorCode: mode === 'timeout' ? 'timeout' : 'recognition_failed'
          }
        ]
      })
      expect(record.dispatch.status).toBe('accepted')
    } finally {
      vi.useRealTimers()
      await fx.close()
    }
  }
)

it('preserves attachment order and independent successes when one of several audio clips fails', async () => {
  const fx = await speechFixture(
    recognizer(async ({ media }): Promise<SpeechRecognition> =>
      media.reference.fileName === 'second.wav'
        ? { status: 'failed', errorCode: 'recognition_failed' }
        : { status: 'transcribed', text: 'first voice' }
    )
  )

  try {
    const receipt = await fx.channel.ingest({
      ...incoming,
      attachments: [audio, picture, { ...audio, fileName: 'second.wav' }]
    })

    await fx.runtime.processDue()

    const raw = required(
      await fx.storage.getInbound(receipt.requestId)
    ).snapshot

    expect(fx.dispatched[0]?.attachments).toEqual(raw.attachments)
    expect(fx.dispatched[0]?.transcriptions).toEqual([
      {
        mediaId: raw.attachments?.[0]?.id,
        status: 'transcribed',
        text: 'first voice'
      },
      {
        mediaId: raw.attachments?.[2]?.id,
        status: 'failed',
        errorCode: 'recognition_failed'
      }
    ])
  } finally {
    await fx.close()
  }
})

it.each(['waiting', 'interrupted', 'disabled'] as const)(
  'recovers %s preparation after reopening the database',
  async (mode) => {
    const call = vi.fn(async (): Promise<SpeechRecognition> => ({
      status: 'transcribed',
      text: 'resumed'
    }))

    const fx = await speechFixture(recognizer(call))
    try {
      const receipt = await fx.channel.ingest({
        ...incoming,
        text: 'original',
        attachments: [audio]
      })

      if (mode === 'interrupted') {
        const now = Date.now()

        const work = required(
          (
            await fx.storage.takeDue({
              now,
              leaseMs: 1000,
              limit: 1,
              leaseOwner: 'crashed',
              safeRetryAccountIds: []
            })
          )[0]
        )

        expect(work.kind).toBe('transcribe')
        vi.spyOn(Date, 'now').mockReturnValue(now + 1001)
      }
      const runtime = await fx.restart(mode === 'disabled' ? null : undefined)
      await runtime.processDue()
      expect(fx.dispatched).toHaveLength(1)
      const record = required(await fx.storage.getInbound(receipt.requestId))
      expect(fx.dispatched[0]?.attachments).toEqual(record.snapshot.attachments)
      if (mode === 'waiting') {
        expect(call).toHaveBeenCalledOnce()
        expect(record.transcriptions?.[0]).toMatchObject({
          status: 'transcribed',
          text: 'resumed'
        })
      } else {
        expect(call).not.toHaveBeenCalled()
        expect(fx.dispatched[0]?.text).toBe('original')
        expect(record.transcriptions?.[0]).toMatchObject({
          status: 'failed',
          errorCode: mode
        })
      }
    } finally {
      vi.restoreAllMocks()
      await fx.close()
    }
  }
)
