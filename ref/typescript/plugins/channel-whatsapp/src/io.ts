import type {
  ChannelHost,
  IngestInput,
  SecretRef,
  SendResult
} from '@relanox/sdk'
import { z } from 'zod'
import { readJson } from '@relanox/transport'
import { errorResponseSchema } from './schemas.js'

export { signed } from '@relanox/transport'
export { rawBody, parseBody, request } from '@relanox/transport'

export function secret(ref: SecretRef): string {
  const value = process.env[ref.env]
  if (!value) {
    throw new Error('missing_credential')
  }
  return value
}

export async function ingest(
  host: ChannelHost,
  input: IngestInput
): Promise<void> {
  try {
    await host.ingest(input)
  } catch (error) {
    const code = z.object({ code: z.string() }).safeParse(error)
    if (
      !code.success ||
      ![
        'sender_not_allowed',
        'unbound_conversation',
        'media_total_too_large'
      ].includes(code.data.code)
    ) {
      throw error
    }
    host.observe.log('info', 'channel_policy_rejection', {
      errorCode: code.data.code
    })
  }
}

async function nativeRateLimit(response: Response): Promise<boolean> {
  try {
    const parsed = errorResponseSchema.parse(await readJson(response))
    return [4, 80_007, 130_429, 131_056].includes(parsed.error.code)
  } catch {
    return false
  }
}

export async function failure(response: Response): Promise<SendResult> {
  try {
    const limited =
      response.status === 429 ||
      (response.status === 400 && (await nativeRateLimit(response)))

    if (limited) {
      const seconds = Number(response.headers.get('retry-after'))

      const delay =
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000

      return {
        status: 'retryable',
        errorCode: 'rate_limited',
        retryAfterMs: delay
      }
    }

    const status =
      response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown'

    return { status, errorCode: `provider_http_${response.status}` }
  } finally {
    await response.body?.cancel().catch(() => {})
  }
}

export function unavailable(): SendResult {
  return { status: 'unknown', errorCode: 'transport_or_response_unknown' }
}
