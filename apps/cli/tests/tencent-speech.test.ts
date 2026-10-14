import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { StoredMedia } from '@relanox/sdk'
import { createTencentSpeechToText } from '../src/speech/tencent.js'
import { speechToTextSchema } from '../src/speech/config.js'
import { tencentPeer } from './tencent-peer.js'
import { speechFixture } from '../../../tests/core/speech-fixture.js'
import { incoming } from '../../../tests/core/fixture.js'
import { required } from '../../../tests/contracts/storage-contract.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const configuration = {
  provider: 'tencent',
  secretId: { env: 'TEST_ASR_ID' },
  secretKey: { env: 'TEST_ASR_KEY' },
  engine: '16k_zh'
}

function provider(): ReturnType<typeof createTencentSpeechToText> {
  vi.stubEnv('TEST_ASR_ID', 'AKIDEXAMPLE')
  vi.stubEnv('TEST_ASR_KEY', 'SECRETEXAMPLE')
  return createTencentSpeechToText(speechToTextSchema.parse(configuration))
}

function media(
  data = Buffer.from('RIFFtestWAVEfmt '),
  mimeType = 'audio/wav'
): StoredMedia {
  return {
    data,
    reference: {
      id: 'voice',
      kind: 'audio',
      fileName: 'voice.wav',
      mimeType,
      size: data.length,
      durationMs: 1000,
      sha256: createHash('sha256').update(data).digest('hex')
    }
  }
}

it('sends a signed native Data request and carries the transcript through durable preparation to dot', async () => {
  const peer = await tencentPeer()
  const speech = provider()
  const fx = await speechFixture(speech)
  try {
    // Fixed UTC instant, deliberately on a different calendar date in UTC+8.
    vi.spyOn(Date, 'now').mockReturnValue(1_551_113_065_000)
    const audio = media()

    const receipt = await fx.channel.ingest({
      ...incoming,
      text: '请听语音',
      attachments: [
        {
          kind: 'audio',
          mimeType: 'audio/wav',
          fileName: 'voice.wav',
          data: audio.data
        }
      ]
    })

    expect(peer.requests).toHaveLength(0)
    await fx.runtime.processDue()
    expect(peer.requests).toHaveLength(1)
    const request = required(peer.requests[0])
    expect(JSON.parse(request.body)).toEqual({
      EngSerViceType: '16k_zh',
      SourceType: 1,
      VoiceFormat: 'wav',
      Data: 'UklGRnRlc3RXQVZFZm10IA==',
      DataLen: 16
    })
    expect(request.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'x-tc-action': 'SentenceRecognition',
      'x-tc-version': '2019-06-14',
      'x-tc-timestamp': '1551113065'
    })
    // Golden signature calculated independently using Python hashlib/hmac and the TC3 specification:
    // https://cloud.tencent.com/document/product/876/34813
    expect(request.headers.authorization).toBe(
      'TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-25/asr/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=62b67a3251e378be96f9ad26cfc1e094797f801f4a72c11f06f0ba5e304eba44'
    )
    const record = required(await fx.storage.getInbound(receipt.requestId))
    expect(record.transcriptions).toEqual([
      {
        mediaId: required(record.snapshot.attachments?.[0]).id,
        status: 'transcribed',
        text: '腾讯云语音识别欢迎您。'
      }
    ])
    expect(fx.dispatched[0]?.text).toContain('腾讯云语音识别欢迎您。')
    expect(fx.dispatched[0]?.attachments).toEqual(record.snapshot.attachments)
  } finally {
    await fx.close()
    await peer.close()
  }
})

it.each([
  {
    name: 'quota failure',
    body: {
      Response: {
        Error: {
          Code: 'FailedOperation.UserHasNoAmount',
          Message: 'private provider diagnostic'
        },
        RequestId: 'error-id'
      }
    },
    status: 200,
    code: 'recognition_failed'
  },
  {
    name: 'HTTP failure',
    body: { private: 'diagnostic' },
    status: 503,
    code: 'provider_unavailable'
  },
  {
    name: 'empty transcript',
    body: {
      Response: { Result: ' ', AudioDuration: 1000, RequestId: 'empty-id' }
    },
    status: 200,
    code: 'invalid_response'
  },
  {
    name: 'malformed response',
    body: { Response: { Result: 123, RequestId: 'bad-id' } },
    status: 200,
    code: 'invalid_response'
  },
  {
    name: 'oversized response',
    body: { Response: { Result: 'x'.repeat(140_000), RequestId: 'large-id' } },
    status: 200,
    code: 'invalid_response'
  }
])('returns a safe fallback once on $name', async ({ body, status, code }) => {
  const peer = await tencentPeer()
  try {
    peer.reply(body, status)

    const result = await provider().recognize({
      media: media(),
      engine: '16k_zh',
      signal: new AbortController().signal
    })

    expect(result).toEqual({ status: 'failed', errorCode: code })
    expect(peer.requests).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('private')
  } finally {
    await peer.close()
  }
})

it.each([
  { name: 'WAV', mime: 'audio/wav', bytes: 'RIFFtestWAVEfmt ', format: 'wav' },
  {
    name: 'QQ SILK mislabeled AMR',
    mime: 'audio/amr',
    bytes: '\u0002#!SILK_V3\n',
    format: 'silk'
  },
  {
    name: 'Ogg Opus',
    mime: 'audio/ogg',
    bytes: 'OggS------------------------OpusHead',
    format: 'ogg-opus'
  },
  { name: 'M4A', mime: 'audio/mp4', bytes: 'ftypM4A', format: 'm4a' }
])('uses the native encoding for $name', async ({ mime, bytes, format }) => {
  const peer = await tencentPeer()
  try {
    expect(
      await provider().recognize({
        media: media(Buffer.from(bytes), mime),
        engine: '16k_en',
        signal: new AbortController().signal
      })
    ).toMatchObject({ status: 'transcribed' })
    expect(JSON.parse(required(peer.requests[0]).body)).toMatchObject({
      VoiceFormat: format,
      EngSerViceType: '16k_en',
      DataLen: Buffer.byteLength(bytes)
    })
  } finally {
    await peer.close()
  }
})

it('skips unsupported formats and over-limit inputs before sending data to Tencent', async () => {
  const call = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', call)
  const speech = provider()

  const cases = [
    {
      audio: media(Buffer.from('webm'), 'audio/webm'),
      errorCode: 'unsupported_format'
    },
    {
      audio: media(Buffer.from('OggS----vorbis'), 'audio/ogg'),
      errorCode: 'unsupported_format'
    },
    { audio: media(Buffer.alloc(2_250_001)), errorCode: 'audio_too_large' },
    {
      audio: {
        ...media(),
        reference: { ...media().reference, durationMs: 60_001 }
      },
      errorCode: 'audio_too_long'
    }
  ]

  for (const item of cases) {
    expect(
      await speech.recognize({
        media: item.audio,
        engine: '16k_zh',
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'failed', errorCode: item.errorCode })
  }
  expect(call).not.toHaveBeenCalled()
})

it('aborts a cloud call on cancellation and does not retry a potentially charged request', async () => {
  const controller = new AbortController()

  const call = vi.fn<typeof fetch>(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('cancelled'))
          },
          { once: true }
        )
      })
  )

  vi.stubGlobal('fetch', call)

  const recognition = provider().recognize({
    media: media(),
    engine: '16k_zh',
    signal: controller.signal
  })

  controller.abort()
  expect(await recognition).toEqual({ status: 'failed', errorCode: 'timeout' })
  expect(call).toHaveBeenCalledOnce()
})
