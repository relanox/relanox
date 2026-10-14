import {
  ApiError,
  UploadDailyLimitExceededError
} from '@tencent-connect/qqbot-nodejs'
import type { SendResult } from '@relanox/sdk'
import { errorSchema } from './schemas.js'

export function apiError(
  raw: unknown,
  mediaUpload = false
): Exclude<SendResult, { status: 'sent' | 'pending' }> | undefined {
  const error = errorSchema.safeParse(raw)
  if (!error.success || error.data.code === 0) {
    return undefined
  }
  const code = error.data.code
  if (code === 40_054_005) {
    return { status: 'unknown', errorCode: 'qq_duplicate_effect' }
  }
  if (
    [40_034_100, 50_055_001, 50_055_006].includes(code) ||
    (mediaUpload && [40_093_001, 850_027].includes(code))
  ) {
    return { status: 'retryable', errorCode: `qq_${code}`, retryAfterMs: 1000 }
  }
  return { status: 'rejected', errorCode: `qq_${code}` }
}

export function sdkFailure(error: unknown, transmitting: boolean): SendResult {
  if (error instanceof UploadDailyLimitExceededError) {
    return { status: 'rejected', errorCode: 'qq_upload_daily_limit' }
  }
  if (
    error instanceof Error &&
    [
      'media_publication_unavailable',
      'invalid_publication_url',
      'rich_text_limit_exceeded'
    ].includes(error.message)
  ) {
    return { status: 'rejected', errorCode: error.message }
  }
  if (error instanceof ApiError) {
    const business = apiError({ code: error.bizCode }, !transmitting)
    if (business) {
      return business
    }
    if (error.httpStatus === 429) {
      return {
        status: 'retryable',
        errorCode: 'rate_limited',
        retryAfterMs: 1000
      }
    }
    if (error.httpStatus >= 400 && error.httpStatus < 500) {
      return { status: 'rejected', errorCode: `http_${error.httpStatus}` }
    }
  }
  return transmitting
    ? { status: 'unknown', errorCode: 'transport_uncertain' }
    : {
        status: 'retryable',
        errorCode: 'media_upload_unavailable',
        retryAfterMs: 1000
      }
}
