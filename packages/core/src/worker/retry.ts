import type { DispatchResult, SendResult } from '@relanox/sdk'
import type { WorkerConfig } from './options.js'

export function retryDelay(
  outcome: DispatchResult | SendResult,
  attempts: number,
  worker: WorkerConfig
): number {
  let delay = 0
  if (outcome.status === 'pending') {
    return Math.max(
      worker.retryBaseMs,
      Math.min(worker.retryMaxMs, outcome.retryAfterMs)
    )
  }
  if (outcome.status === 'retryable') {
    delay = Math.max(
      worker.retryBaseMs,
      Math.min(
        worker.retryMaxMs,
        Number.isFinite(outcome.retryAfterMs) &&
          (outcome.retryAfterMs ?? 0) >= 0
          ? (outcome.retryAfterMs ?? 0)
          : worker.retryBaseMs * 2 ** attempts
      )
    )
  }

  return delay
}

export function retryBudgetExhausted(
  outcome: DispatchResult | SendResult,
  attempts: number,
  maximum: number
): boolean {
  return outcome.status === 'retryable' && attempts + 1 >= maximum
}
