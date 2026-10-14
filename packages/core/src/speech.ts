import { failedTranscriptions } from '@relanox/sdk'
import type {
  DispatchInput,
  InboundRecord,
  MediaReference,
  Observability,
  SpeechRecognition,
  SpeechToTextProvider,
  SpeechTranscription,
  Storage
} from '@relanox/sdk'
import { z } from 'zod'
import { verifiedMedia } from './media.js'

const recognitionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('transcribed'),
    text: z.string().trim().min(1).max(16_384)
  }),
  z.strictObject({
    status: z.literal('failed'),
    errorCode: z.enum([
      'unsupported_format',
      'audio_too_large',
      'audio_too_long',
      'media_unavailable',
      'provider_unavailable',
      'recognition_failed',
      'invalid_response',
      'timeout',
      'interrupted',
      'disabled'
    ])
  })
])

/** Shared projection for notifications and agent reads; raw content stays immutable. */
export function preparedRequest(
  record: InboundRecord
): DispatchInput['request'] {
  const transcripts = (record.transcriptions ?? []).flatMap((result) =>
    result.status === 'transcribed'
      ? [`[Voice transcript: ${result.mediaId}]\n${result.text}`]
      : []
  )

  return {
    ...record.snapshot,
    text: [record.snapshot.text, ...transcripts].filter(Boolean).join('\n\n'),
    ...(record.transcriptions ? { transcriptions: record.transcriptions } : {})
  }
}

async function recognizeMedia(
  storage: Storage,
  record: InboundRecord,
  reference: MediaReference,
  provider: SpeechToTextProvider,
  signal: AbortSignal
): Promise<SpeechRecognition> {
  try {
    const stored = await storage.media?.get(
      record.snapshot.channel.id,
      reference.id
    )

    if (!stored) {
      return { status: 'failed', errorCode: 'media_unavailable' }
    }
    const media = verifiedMedia(stored, reference, reference.size)
    signal.throwIfAborted()

    const result = await provider.recognize({
      media,
      engine: record.snapshot.speechToText?.engine ?? provider.engine,
      signal
    })

    return recognitionSchema.parse(result)
  } catch {
    return {
      status: 'failed',
      errorCode: signal.aborted ? 'timeout' : 'recognition_failed'
    }
  }
}

/** One bounded preparation attempt, independent of notification retry accounting. */
export async function transcribeRequest(
  record: InboundRecord,
  storage: Storage,
  provider: SpeechToTextProvider | undefined,
  timeoutMs: number,
  observe: Observability
): Promise<readonly SpeechTranscription[]> {
  if (!provider) {
    return failedTranscriptions(record.snapshot, 'disabled')
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = Date.now()

  const span = observe.span(
    'transcribe',
    { plugin: 'core', operation: 'transcribe' },
    record.snapshot.trace
  )

  let success = false
  try {
    const timeout = new Promise<SpeechRecognition>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ status: 'failed', errorCode: 'timeout' })
      }, timeoutMs)
    })

    const audio = (record.snapshot.attachments ?? []).filter(
      (media) => media.kind === 'audio'
    )

    const recognized = await Promise.all(
      audio.map(async (media) =>
        Promise.race([
          recognizeMedia(storage, record, media, provider, controller.signal),
          timeout
        ])
      )
    )

    const results: SpeechTranscription[] = []
    for (const [index, media] of audio.entries()) {
      const result = recognized[index]
      if (result) {
        results.push({ mediaId: media.id, ...result })
      }
    }

    success = results.every((result) => result.status === 'transcribed')
    for (const result of results) {
      observe.count('relanox_transcription_total', { outcome: result.status })
      if (result.status === 'failed') {
        observe.log('warn', 'transcription.failed', {
          plugin: 'core',
          requestId: record.snapshot.requestId,
          errorCode: result.errorCode
        })
      }
    }
    return results
  } finally {
    clearTimeout(timer)
    span.end(success ? 'ok' : 'error')
    observe.record(
      'relanox_transcription_duration_seconds',
      (Date.now() - started) / 1000,
      { operation: 'transcribe' }
    )
  }
}
