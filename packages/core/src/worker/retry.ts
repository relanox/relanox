import type { DispatchResult, SendResult } from "@relanox/sdk";
import type { WorkerConfig } from "./options.js";

export function retryDelay(
  outcome: DispatchResult | SendResult,
  attempts: number,
  worker: WorkerConfig,
): number {
  let delay = 0;
  if (outcome.status === "accepted") {
    delay = worker.notificationIntervalMs;
  } else if (outcome.status === "retryable") {
    delay = Math.max(
      worker.retryBaseMs,
      Math.min(
        worker.retryMaxMs,
        Number.isFinite(outcome.retryAfterMs) && (outcome.retryAfterMs ?? 0) >= 0
          ? (outcome.retryAfterMs ?? 0)
          : worker.retryBaseMs * 2 ** attempts,
      ),
    );
  }

  return delay;
}

export function retryBudgetExhausted(
  outcome: DispatchResult | SendResult,
  attempts: number,
  maximum: number,
): boolean {
  return (
    (outcome.status === "retryable" || outcome.status === "accepted") && attempts + 1 >= maximum
  );
}
