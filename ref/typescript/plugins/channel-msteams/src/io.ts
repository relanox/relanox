import type {
  ChannelHost,
  IngestInput,
  SecretRef,
  SendResult
} from '@relanox/sdk'
import { z } from 'zod'

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
        'media_too_large',
        'media_total_too_large',
        'too_many_attachments'
      ].includes(code.data.code)
    ) {
      throw error
    }
    host.observe.log('info', 'channel_policy_rejection', {
      errorCode: code.data.code
    })
  }
}

type FailureResult = Extract<
  SendResult,
  { status: 'retryable' | 'rejected' | 'unknown' }
>

export function failure(response: Response): FailureResult {
  if (response.status === 429) {
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
}

export function unavailable(): FailureResult {
  return { status: 'unknown', errorCode: 'transport_or_response_unknown' }
}

const sdkErrorSchema = z.object({
  response: z
    .object({
      status: z.number().int(),
      headers: z
        .object({ 'retry-after': z.coerce.string().optional() })
        .optional()
    })
    .optional(),
  errorCode: z.string().optional()
})

export function platformFailure(error: unknown, oauth = false): FailureResult {
  const parsed = sdkErrorSchema.safeParse(error)
  const response = parsed.success ? parsed.data.response : undefined
  if (response?.status === 401 && !oauth) {
    return { status: 'retryable', errorCode: 'oauth_token_rejected' }
  }
  if (response) {
    return failure(
      new Response(null, {
        status: response.status,
        headers: response.headers?.['retry-after']
          ? { 'retry-after': response.headers['retry-after'] }
          : {}
      })
    )
  }
  if (oauth) {
    const permanent =
      parsed.success &&
      ['invalid_client', 'invalid_grant', 'unauthorized_client'].includes(
        parsed.data.errorCode ?? ''
      )

    return {
      status: permanent ? 'rejected' : 'retryable',
      errorCode: 'oauth_unavailable'
    }
  }
  return unavailable()
}
