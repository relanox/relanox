import type { SendResult } from '@relanox/sdk'
import { errorSchema } from './schemas.js'

export function apiError(
  raw: unknown,
  mediaUpload = false
): Exclude<SendResult, { status: 'sent' }> | undefined {
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
