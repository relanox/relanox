import type { StoredMedia } from '@relanox/sdk'

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
    }

export type SpeechTranscription = SpeechRecognition & {
  readonly mediaId: string
}

/** Adapter boundary used by the speech middleware, not by core or storage. */
export type SpeechToTextProvider = {
  readonly engine: string
  recognize(input: {
    readonly media: StoredMedia
    readonly engine: string
    readonly signal: AbortSignal
  }): Promise<SpeechRecognition>
}
