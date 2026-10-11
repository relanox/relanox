import type { SendResult } from '@relanox/sdk'
import { responseSchema } from './schemas.js'
import { failure, jsonResponse } from './transport.js'

export async function sendOutcome(response: Response): Promise<SendResult> {
  const result = responseSchema.safeParse(
    await jsonResponse(response).catch(() => null)
  )

  if (response.status === 429) {
    return result.success && result.data.parameters?.retry_after
      ? {
          status: 'retryable',
          errorCode: 'rate_limited',
          retryAfterMs: result.data.parameters.retry_after * 1000
        }
      : failure(response)
  }
  if (!result.success) {
    return response.ok
      ? { status: 'unknown', errorCode: 'invalid_platform_response' }
      : failure(response)
  }
  if (!result.data.ok) {
    if (result.data.error_code === 429) {
      return {
        status: 'retryable',
        errorCode: 'rate_limited',
        ...(result.data.parameters?.retry_after
          ? { retryAfterMs: result.data.parameters.retry_after * 1000 }
          : {})
      }
    }
    return {
      status:
        result.data.error_code && result.data.error_code < 500
          ? 'rejected'
          : 'unknown',
      errorCode: 'telegram_api_error'
    }
  }
  if (!response.ok || !result.data.result) {
    return { status: 'unknown', errorCode: 'invalid_platform_response' }
  }
  return {
    status: 'sent',
    receipt: { platformMessageId: String(result.data.result.message_id) }
  }
}
