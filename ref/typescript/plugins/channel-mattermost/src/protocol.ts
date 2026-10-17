import { ClientError } from '@mattermost/client'
import type {
  ChannelHost,
  IngestInput,
  SendResult,
  SecretRef
} from '@relanox/sdk'
import { z } from 'zod'

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
          'too_many_attachments',
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

export function sendFailure(error: unknown): SendResult {
  if (error instanceof ClientError && error.status_code === 429) {
    // Client4 exposes the native error status, but not Retry-After headers.
    return {
      status: 'retryable',
      errorCode: 'rate_limited',
      retryAfterMs: 1000
    }
  }
  if (error instanceof ClientError && error.status_code === 413) {
    return { status: 'rejected', errorCode: 'media_limit_exceeded' }
  }
  if (
    error instanceof ClientError &&
    error.status_code !== undefined &&
    error.status_code >= 400 &&
    error.status_code < 500
  ) {
    return { status: 'rejected', errorCode: 'platform_rejected' }
  }
  return { status: 'unknown', errorCode: 'send_outcome_unknown' }
}
