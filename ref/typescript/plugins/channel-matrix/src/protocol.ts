import type {
  ChannelHost,
  IngestInput,
  SendResult,
  SecretRef
} from '@relanox/sdk'
import { z } from 'zod'
import { HTTPError, MatrixError } from 'matrix-js-sdk'

export function secret(
  ref: SecretRef,
  environment: Readonly<Record<string, string | undefined>>
): string {
  const value = environment[ref.env]
  if (!value || /[\r\n]/u.test(value)) {
    throw new Error('invalid_secret')
  }
  return value
}

export function diagnose(host: ChannelHost, errorCode: string): void {
  host.observe.log('warn', 'operation.failed', {
    operation: 'receive',
    errorCode
  })
  if (errorCode.endsWith('_unsupported')) {
    host.observe.count('relanox_inbound_total', {
      outcome: 'rejected',
      error_class: 'unsupported'
    })
  }
}

export async function ingest(
  host: ChannelHost,
  input: IngestInput
): Promise<void> {
  try {
    await host.ingest(input)
  } catch (error) {
    const code = z
      .object({
        code: z.enum([
          'sender_not_allowed',
          'unbound_conversation',
          'media_too_large',
          'media_total_too_large'
        ])
      })
      .safeParse(error)

    if (!code.success) {
      throw error
    }
    diagnose(host, code.data.code)
  }
}

function retryDelay(error: HTTPError): number {
  try {
    const milliseconds = error.getRetryAfterMs()
    return milliseconds !== null && Number.isSafeInteger(milliseconds)
      ? Math.max(0, milliseconds)
      : 1000
  } catch {
    // HTTP 429 proves refusal even if its optional retry metadata is unavailable.
    return 1000
  }
}

export function sendFailure(error: unknown): SendResult {
  if (error instanceof HTTPError && error.httpStatus === 429) {
    return {
      status: 'retryable',
      errorCode: 'rate_limited',
      retryAfterMs: retryDelay(error)
    }
  }
  if (
    error instanceof HTTPError &&
    (error.httpStatus === 413 ||
      (error instanceof MatrixError && error.errcode === 'M_TOO_LARGE'))
  ) {
    return { status: 'rejected', errorCode: 'media_limit_exceeded' }
  }
  if (
    error instanceof HTTPError &&
    error.httpStatus !== undefined &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500
  ) {
    return { status: 'rejected', errorCode: 'platform_rejected' }
  }
  return { status: 'unknown', errorCode: 'send_outcome_unknown' }
}
