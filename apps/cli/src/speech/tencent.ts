import type {
  SpeechRecognition,
  SpeechToTextProvider,
  StoredMedia
} from '@relanox/sdk'
import { z } from 'zod'
import type { SpeechToTextConfig } from './config.js'
import { speechCredentials } from './config.js'
import { tencentHeaders } from './tencent-signature.js'

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

const responseSchema = z.object({
  Response: z.object({
    Error: z.object({ Code: z.string(), Message: z.string() }).optional(),
    Result: z.string().optional(),
    AudioDuration: z.number().int().nonnegative().optional(),
    RequestId: z.string()
  })
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

async function readResult(response: Response): Promise<SpeechRecognition> {
  try {
    if (!response.body) {
      return { status: 'failed', errorCode: 'invalid_response' }
    }
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > 131_072) {
        return { status: 'failed', errorCode: 'invalid_response' }
      }
      chunks.push(chunk)
    }

    const { Response: result } = responseSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8'))
    )

    if (result.Error) {
      return { status: 'failed', errorCode: 'recognition_failed' }
    }
    const text = result.Result?.trim()
    if (!text || text.length > 16_384 || result.AudioDuration === undefined) {
      return { status: 'failed', errorCode: 'invalid_response' }
    }
    return { status: 'transcribed', text }
  } catch {
    return { status: 'failed', errorCode: 'invalid_response' }
  }
}

/** SentenceRecognition protocol: https://cloud.tencent.com/document/api/1093/35646 */
export function createTencentSpeechToText(
  config: SpeechToTextConfig
): SpeechToTextProvider {
  const credentials = speechCredentials(config)
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
        const body = JSON.stringify({
          EngSerViceType: engine,
          SourceType: 1,
          VoiceFormat: format,
          Data: Buffer.from(media.data).toString('base64'),
          DataLen: media.data.byteLength
        })

        const response = await fetch('https://asr.tencentcloudapi.com/', {
          method: 'POST',
          headers: tencentHeaders(body, credentials),
          body,
          signal: boundedSignal,
          redirect: 'error'
        })

        if (!response.ok) {
          await response.body?.cancel()
          return { status: 'failed', errorCode: 'provider_unavailable' }
        }
        const result = await readResult(response)
        return boundedSignal.aborted
          ? { status: 'failed', errorCode: 'timeout' }
          : result
      } catch {
        return {
          status: 'failed',
          errorCode: boundedSignal.aborted ? 'timeout' : 'provider_unavailable'
        }
      }
    }
  }
}
