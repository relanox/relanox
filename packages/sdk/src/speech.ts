import type { InboundRecord, InboundSnapshot } from './messages.js'
import type { StoredMedia } from './media.js'
import type { PluginMetadata } from './plugins.js'
import type { Json } from './values.js'

export type SpeechRecognition =
  | { readonly status: 'transcribed'; readonly text: string }
  | {
      readonly status: 'failed'
      readonly errorCode:
        | 'unsupported_format'
        | 'audio_too_large'
        | 'audio_too_long'
        | 'media_unavailable'
        | 'provider_unavailable'
        | 'recognition_failed'
        | 'invalid_response'
        | 'timeout'
        | 'interrupted'
        | 'disabled'
    }

/** Derived content never replaces the retained original audio or inbound snapshot. */
export type SpeechTranscription = SpeechRecognition & {
  readonly mediaId: string
}

/** Production boundary between the durable preparation worker and cloud recognition. */
export type SpeechToTextProvider = {
  readonly provider: string
  readonly engine: string
  recognize(input: {
    readonly media: StoredMedia
    readonly engine: string
    readonly signal: AbortSignal
  }): Promise<SpeechRecognition>
}

/** Optional cloud speech adapter; core supplies audio independently of the destination agent. */
export type SpeechPlugin<C = Json> = {
  readonly kind: 'speech'
  validateConfig(config: unknown): C
  setup(config: C): Promise<SpeechToTextProvider>
} & PluginMetadata

export function needsTranscription(record: InboundRecord): boolean {
  return (
    Boolean(record.snapshot.speechToText) && record.transcriptions === undefined
  )
}

export function failedTranscriptions(
  snapshot: InboundSnapshot,
  errorCode: Extract<SpeechRecognition, { status: 'failed' }>['errorCode']
): readonly SpeechTranscription[] {
  return (snapshot.attachments ?? [])
    .filter((media) => media.kind === 'audio')
    .map((media) => ({ mediaId: media.id, status: 'failed', errorCode }))
}
