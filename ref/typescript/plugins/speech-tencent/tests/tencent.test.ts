import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { StoredMedia } from '@relanox/sdk'
import { tencentSpeechPlugin } from '../src/index.js'
import { tencentPeer } from './peer.js'
import { middlewareFixture } from '../../../tests/core/middleware-fixture.js'
import { createTencentSpeechToText } from '../src/tencent.js'
import { incoming } from '../../../tests/core/fixture.js'
import { required } from '../../../tests/contracts/storage-contract.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

const configuration = {
  secretId: { env: 'TEST_ASR_ID' },
  secretKey: { env: 'TEST_ASR_KEY' },
  engine: '16k_zh'
}

async function provider(): Promise<
  ReturnType<typeof createTencentSpeechToText>
> {
  vi.stubEnv('TEST_ASR_ID', 'AKIDEXAMPLE')
  vi.stubEnv('TEST_ASR_KEY', 'SECRETEXAMPLE')
  return createTencentSpeechToText(
    tencentSpeechPlugin.validateConfig(configuration)
  )
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

it.each(['dot', 'grok'] as const)(
  'uses the real Tencent SDK and carries its transcript through durable preparation to %s',
  async (agent) => {
    const peer = await tencentPeer()
    await provider()

    const fx = await middlewareFixture(
      [
        await tencentSpeechPlugin.setup(
          tencentSpeechPlugin.validateConfig(configuration)
        )
      ],
      agent
    )

    try {
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
        'content-type': 'application/json',
        'x-tc-action': 'SentenceRecognition',
        'x-tc-version': '2019-06-14'
      })
      // Check that the configured identity reaches SDK authentication, not its signature algorithm.
      expect(request.headers.authorization).toMatch(
        /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\//u
      )
      const record = required(await fx.storage.getInbound(receipt.requestId))
      expect(fx.dispatched[0]?.extensions?.['speech-tencent']).toEqual({
        transcriptions: [
          {
            mediaId: required(record.snapshot.attachments?.[0]).id,
            status: 'transcribed',
            text: '腾讯云语音识别欢迎您。'
          }
        ]
      })
      expect(fx.dispatched[0]?.text).toContain('腾讯云语音识别欢迎您。')
      expect(fx.dispatched[0]?.attachments).toEqual(record.snapshot.attachments)
    } finally {
      await fx.close()
      await peer.close()
    }
  }
)

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
    name: 'oversized transcript',
    body: { Response: { Result: 'x'.repeat(16_385), RequestId: 'large-id' } },
    status: 200,
    code: 'invalid_response'
  }
])('returns a safe fallback once on $name', async ({ body, status, code }) => {
  const peer = await tencentPeer()
  try {
    peer.reply(body, status)

    const result = await (
      await provider()
    ).recognize({
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
      await (
        await provider()
      ).recognize({
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
  const peer = await tencentPeer()
  const speech = await provider()

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

  try {
    for (const item of cases) {
      expect(
        await speech.recognize({
          media: item.audio,
          engine: '16k_zh',
          signal: new AbortController().signal
        })
      ).toEqual({ status: 'failed', errorCode: item.errorCode })
    }
    expect(peer.requests).toHaveLength(0)
  } finally {
    await peer.close()
  }
})

it.each(['cancellation', 'deadline'] as const)(
  'closes the SDK connection on %s without retrying a potentially charged request',
  async (mode) => {
    const peer = await tencentPeer()
    const controller = new AbortController()
    try {
      peer.hold()

      const recognition = (await provider()).recognize({
        media: media(),
        engine: '16k_zh',
        signal: controller.signal
      })

      await vi.waitFor(() => {
        expect(peer.requests).toHaveLength(1)
      })
      if (mode === 'cancellation') {
        controller.abort()
      }
      expect(await recognition).toEqual({
        status: 'failed',
        errorCode: 'timeout'
      })
      await vi.waitFor(() => {
        expect(peer.closedResponses).toBe(1)
      })
      expect(peer.requests).toHaveLength(1)
    } finally {
      controller.abort()
      await peer.close()
    }
  }
)

it('does not start a cloud request after preparation has already expired', async () => {
  const peer = await tencentPeer()
  try {
    expect(
      await (
        await provider()
      ).recognize({
        media: media(),
        engine: '16k_zh',
        signal: AbortSignal.abort()
      })
    ).toEqual({ status: 'failed', errorCode: 'timeout' })
    expect(peer.requests).toHaveLength(0)
  } finally {
    await peer.close()
  }
})
