import type { DispatchResult, SendResult } from '@relanox/sdk'
import type { WorkerConfig } from './options.js'

export function retryDelay(
  outcome: DispatchResult | SendResult,
  attempts: number,
  worker: WorkerConfig
): number {
  let delay = 0
  if (outcome.status === 'pending') {
    return Math.max(worker.retryBaseMs, outcome.retryAfterMs)
  }
  if (outcome.status === 'retryable') {
    delay = Math.max(
      worker.retryBaseMs,
      outcome.retryAfterMs ??
        Math.min(worker.retryMaxMs, worker.retryBaseMs * 2 ** attempts)
    )
  }

  return delay
}

/** Keep a remote retry deadline representable by the persisted epoch-millisecond contract. */
export function nextRetryAt(
  outcome: DispatchResult | SendResult,
  attempts: number,
  worker: WorkerConfig,
  now: number
): number {
  return (
    now +
    Math.min(
      Math.ceil(retryDelay(outcome, attempts, worker)),
      Number.MAX_SAFE_INTEGER - now
    )
  )
}

export function retryBudgetExhausted(
  outcome: DispatchResult | SendResult,
  attempts: number,
  maximum: number
): boolean {
  return outcome.status === 'retryable' && attempts + 1 >= maximum
}
