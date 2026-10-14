import type {
  SpeechRecognition,
  SpeechToTextProvider,
  StoredMedia
} from '@relanox/sdk'
import { z } from 'zod'
import { asr } from 'tencentcloud-sdk-nodejs-asr'
import type { SentenceRecognitionRequest } from 'tencentcloud-sdk-nodejs-asr/tencentcloud/services/asr/v20190614/asr_models.js'
import type { TencentSpeechConfig } from './config.js'
import { speechCredentials } from './config.js'

const formats: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/pcm': 'pcm',
  'audio/speex': 'speex',
  'audio/silk': 'silk',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/amr-wb': 'amr'
}

const transcriptSchema = z.object({
  Result: z.string().trim().min(1).max(16_384)
})

function voiceFormat(media: StoredMedia): string | undefined {
  const header = Buffer.from(media.data.subarray(0, 512))
  if (
    header.subarray(0, 9).toString() === '#!SILK_V3' ||
    header.subarray(1, 10).toString() === '#!SILK_V3'
  ) {
    return 'silk'
  }

  const mime =
    media.reference.mimeType.toLowerCase().split(';')[0]?.trim() ?? ''

  if (mime === 'audio/ogg' || mime === 'audio/opus') {
    return header.subarray(0, 4).toString() === 'OggS' &&
      header.includes('OpusHead')
      ? 'ogg-opus'
      : undefined
  }
  return formats[mime]
}

/** SentenceRecognition protocol: https://cloud.tencent.com/document/api/1093/35646 */
export function createTencentSpeechToText(
  config: TencentSpeechConfig
): SpeechToTextProvider {
  const client = new asr.v20190614.Client({
    credential: speechCredentials(config),
    profile: { httpProfile: { reqTimeout: 8 } }
  })

  return {
    provider: 'tencent',
    engine: config.engine,
    async recognize({ media, engine, signal }): Promise<SpeechRecognition> {
      const format = voiceFormat(media)
      if (media.reference.kind !== 'audio' || !format) {
        return { status: 'failed', errorCode: 'unsupported_format' }
      }
      // The Data parameter limit applies AFTER base64 encoding. Use decimal MB conservatively.
      if (4 * Math.ceil(media.data.byteLength / 3) > 3_000_000) {
        return { status: 'failed', errorCode: 'audio_too_large' }
      }
      if ((media.reference.durationMs ?? 0) > 60_000) {
        return { status: 'failed', errorCode: 'audio_too_long' }
      }
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)])
      try {
        boundedSignal.throwIfAborted()

        const request: SentenceRecognitionRequest = {
          EngSerViceType: engine,
          SourceType: 1,
          VoiceFormat: format,
          Data: Buffer.from(media.data).toString('base64'),
          DataLen: media.data.byteLength
        }

        // The generated SentenceRecognition method only types a callback argument.
        // SDK request accepts AbortSignal and still handles signing, HTTP and API errors.
        const response: unknown = await client.request(
          'SentenceRecognition',
          request,
          {
            signal: boundedSignal
          }
        )

        if (boundedSignal.aborted) {
          return { status: 'failed', errorCode: 'timeout' }
        }
        const result = transcriptSchema.safeParse(response)
        return result.success
          ? { status: 'transcribed', text: result.data.Result }
          : { status: 'failed', errorCode: 'invalid_response' }
      } catch (error) {
        if (boundedSignal.aborted) {
          return { status: 'failed', errorCode: 'timeout' }
        }
        // Cloud API errors carry a code; HTTP/transport errors do not. Never expose messages.
        return {
          status: 'failed',
          errorCode:
            error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string'
              ? 'recognition_failed'
              : 'provider_unavailable'
        }
      }
    }
  }
}
