import type { SendResult } from '@relanox/sdk'
import { sendResponseSchema } from './schemas.js'
import { failure, jsonResponse } from './transport.js'

export function apiError(error: string | undefined): SendResult {
  if (error === 'ratelimited') {
    return { status: 'retryable', errorCode: 'rate_limited' }
  }
  if (
    ['internal_error', 'fatal_error', 'service_unavailable'].includes(
      error ?? ''
    )
  ) {
    return { status: 'unknown', errorCode: 'slack_api_error' }
  }
  return { status: 'rejected', errorCode: 'slack_api_error' }
}

export async function sendOutcome(response: Response): Promise<SendResult> {
  if (!response.ok) {
    return failure(response)
  }
  const parsed = sendResponseSchema.safeParse(await jsonResponse(response))
  if (!parsed.success) {
    return { status: 'unknown', errorCode: 'invalid_platform_response' }
  }
  if (!parsed.data.ok) {
    return apiError(parsed.data.error)
  }
  return parsed.data.ts
    ? { status: 'sent', receipt: { platformMessageId: parsed.data.ts } }
    : { status: 'unknown', errorCode: 'invalid_platform_response' }
}
