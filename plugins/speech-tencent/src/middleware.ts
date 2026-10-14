import type { MessageMiddleware } from '@relanox/sdk'
import { z } from 'zod'
import type { SpeechToTextProvider, SpeechTranscription } from './types.js'

const resultSchema = z.discriminatedUnion('status', [
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
      'timeout'
    ])
  })
])

/** Speech-specific selection, derived text and per-clip fallback stay inside this middleware. */
export function createSpeechMiddleware(
  provider: SpeechToTextProvider
): MessageMiddleware {
  return {
    id: 'speech-tencent',
    plan: (message) =>
      message.attachments?.some((media) => media.kind === 'audio')
        ? { engine: provider.engine }
        : undefined,
    async process({ message, options, readMedia, signal, observe }) {
      const { engine } = z.object({ engine: z.string() }).parse(options)
      const started = Date.now()

      const audio = (message.attachments ?? []).filter(
        (media) => media.kind === 'audio'
      )

      const transcriptions = await Promise.all(
        audio.map(async (reference) =>
          recognizeClip(reference.id, provider, engine, { readMedia, signal })
        )
      )

      for (const result of transcriptions) {
        observe.count('relanox_transcription_total', {
          plugin: 'speech-tencent',
          outcome: result.status
        })
        if (result.status === 'failed') {
          observe.log('warn', 'transcription.failed', {
            plugin: 'speech-tencent',
            requestId: message.requestId,
            errorCode: result.errorCode
          })
        }
      }
      observe.record(
        'relanox_transcription_duration_seconds',
        (Date.now() - started) / 1000,
        { plugin: 'speech-tencent', operation: 'prepare' }
      )

      const transcripts = transcriptions.flatMap((result) =>
        result.status === 'transcribed'
          ? [`[Voice transcript: ${result.mediaId}]\n${result.text}`]
          : []
      )

      return {
        text: [message.text, ...transcripts].filter(Boolean).join('\n\n'),
        data: { transcriptions }
      }
    }
  }
}

async function recognizeClip(
  mediaId: string,
  provider: SpeechToTextProvider,
  engine: string,
  input: Pick<
    Parameters<MessageMiddleware['process']>[0],
    'readMedia' | 'signal'
  >
): Promise<SpeechTranscription> {
  const { signal, readMedia } = input
  try {
    const media = await readMedia(mediaId)
    signal.throwIfAborted()

    const result = media
      ? resultSchema.parse(await provider.recognize({ media, engine, signal }))
      : { status: 'failed' as const, errorCode: 'media_unavailable' as const }

    return { mediaId, ...result }
  } catch {
    return {
      mediaId,
      status: 'failed',
      errorCode: signal.aborted ? 'timeout' : 'recognition_failed'
    }
  }
}
