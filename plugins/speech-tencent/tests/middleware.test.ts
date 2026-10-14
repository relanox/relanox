import { expect, it, vi } from 'vitest'
import type { MessageMiddleware } from '@relanox/sdk'
import type { SpeechRecognition, SpeechToTextProvider } from '../src/types.js'
import {
  projectAgentRequest,
  agentRequestSchema
} from '../../../packages/agent-mcp/src/request-payload.js'
import { required } from '../../../tests/contracts/storage-contract.js'
import { incoming, picture } from '../../../tests/core/fixture.js'
import { middlewareFixture } from '../../../tests/core/middleware-fixture.js'
import { createSpeechMiddleware } from '../src/middleware.js'

async function speechFixture(
  provider?: SpeechToTextProvider,
  agent: 'dot' | 'grok' = 'dot'
): ReturnType<typeof middlewareFixture> {
  return middlewareFixture(
    provider ? [createSpeechMiddleware(provider)] : [],
    agent
  )
}

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
  return { engine: 'test-model', recognize }
}

it('composes speech between text middleware and retains its captured engine after restart', async () => {
  const engines: string[] = []

  const provider = recognizer(async ({ engine }) => {
    engines.push(engine)
    return { status: 'transcribed', text: 'recognized' }
  })

  const before: MessageMiddleware = {
    id: 'before',
    plan: () => null,
    async process({ message }) {
      return { text: `prefix:${message.text}` }
    }
  }

  const after: MessageMiddleware = {
    id: 'after',
    plan: () => null,
    async process({ message }) {
      return { text: `${message.text}:suffix` }
    }
  }

  const fx = await middlewareFixture([
    before,
    createSpeechMiddleware(provider),
    after
  ])

  try {
    const receipt = await fx.channel.ingest({
      ...incoming,
      text: 'original',
      attachments: [audio]
    })

    const runtime = await fx.restart([
      after,
      createSpeechMiddleware({ ...provider, engine: 'changed-model' }),
      before
    ])

    await runtime.processDue()

    const raw = required(
      await fx.storage.getInbound(receipt.requestId)
    ).snapshot

    expect(engines).toEqual(['test-model'])
    expect(fx.dispatched[0]?.text).toBe(
      `prefix:original\n\n[Voice transcript: ${required(raw.attachments?.[0]).id}]\nrecognized:suffix`
    )
    expect(fx.dispatched[0]?.attachments).toEqual(raw.attachments)
    expect(fx.dispatched[0]?.extensions?.['speech-tencent']).toMatchObject({
      transcriptions: [{ status: 'transcribed', text: 'recognized' }]
    })
  } finally {
    await fx.close()
  }
})

it.each(['disabled', 'image', 'video'] as const)(
  'does not transcribe for %s and preserves the original forwarding contract',
  async (mode) => {
    const call = vi.fn(async (): Promise<SpeechRecognition> => ({
      status: 'transcribed',
      text: 'unused'
    }))

    const fx = await speechFixture(
      mode === 'disabled' ? undefined : recognizer(call)
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
      expect(fx.dispatched[0]?.extensions?.['speech-tencent']).toBeUndefined()
      expect(fx.dispatched[0]?.attachments).toEqual(
        (await fx.storage.getInbound(receipt.requestId))?.snapshot.attachments
      )
    } finally {
      await fx.close()
    }
  }
)

it.each(['dot', 'grok'] as const)(
  'acknowledges durable audio before recognition and exposes the same prepared text and metadata to %s notification and reads',
  async (agent) => {
    let finish: ((result: SpeechRecognition) => void) | undefined

    const call = vi.fn(
      async () =>
        new Promise<SpeechRecognition>((resolve) => {
          finish = resolve
        })
    )

    const fx = await speechFixture(recognizer(call), agent)
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
      expect(notification.extensions?.['speech-tencent']).toEqual({
        transcriptions: [
          { mediaId: id, status: 'transcribed', text: '你好，明天见。' }
        ]
      })

      const read = required(
        (await fx.principal().readMessages({ requestId: receipt.requestId }))[0]
      )

      expect(projectAgentRequest(read)).toEqual(
        projectAgentRequest(notification)
      )
      expect(
        agentRequestSchema.parse(projectAgentRequest(read)).extensions?.[
          'speech-tencent'
        ]
      ).toEqual(notification.extensions?.['speech-tencent'])
      expect(
        (await fx.storage.getInbound(receipt.requestId))?.snapshot
      ).toEqual(raw.snapshot)
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
  }
)

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
    expect(fx.dispatched[1]?.extensions?.['speech-tencent']).toEqual({
      transcriptions: [
        {
          mediaId: required(accepted.snapshot.attachments?.[0]).id,
          status: 'transcribed',
          text: 'cached transcript'
        }
      ]
    })
  } finally {
    await fx.close()
  }
})

it.each(['failure', 'throw', 'invalid'] as const)(
  'falls back to original audio on %s without rejecting the message',
  async (mode) => {
    const provider = recognizer(async () => {
      if (mode === 'throw') {
        throw new Error('private provider exception')
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

      const work = fx.runtime.processDue()
      await work
      expect(fx.dispatched).toHaveLength(1)
      const record = required(await fx.storage.getInbound(receipt.requestId))
      expect(fx.dispatched[0]).toMatchObject({
        text: 'keep this',
        attachments: record.snapshot.attachments,
        extensions: {
          'speech-tencent': {
            transcriptions: [
              { status: 'failed', errorCode: 'recognition_failed' }
            ]
          }
        }
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
    expect(fx.dispatched[0]?.extensions?.['speech-tencent']).toEqual({
      transcriptions: [
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
      ]
    })
  } finally {
    await fx.close()
  }
})
