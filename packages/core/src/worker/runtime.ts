import type {
  DispatchResult,
  SendResult,
  DueWork,
  RelanoxConfig,
  Observability,
} from "@relanox/sdk";
import type { CoreOptions } from "../types.js";
import type { WorkerConfig } from "./options.js";
import { jsonSnapshot } from "../json.js";
import { validateOutcome } from "./outcomes.js";
import { retryDelay, retryBudgetExhausted } from "./retry.js";

/** Owns one-at-a-time leases, plugin deadlines, retry settlement, and worker readiness. */
export function createWorker(
  options: CoreOptions,
  config: RelanoxConfig,
  worker: WorkerConfig,
  observe: Observability,
  isAccepting: () => boolean,
) {
  const storage = options.storage;
  let busy = false;
  let workerError = false;
  const owner = crypto.randomUUID();
  async function refreshStats(): Promise<void> {
    try {
      const stats = await storage.getStats();
      observe.record("relanox_pending", stats.pending);
      observe.record("relanox_claimed", stats.claimed);
      observe.record("relanox_outbound", stats.undelivered);
      observe.record("relanox_unknown", stats.unknown);
      observe.record(
        "relanox_oldest_pending_age_seconds",
        stats.oldestPendingAt === undefined
          ? 0
          : Math.max(0, (Date.now() - stats.oldestPendingAt) / 1000),
      );
      observe.record("relanox_storage_stats_stale", 0);
    } catch {
      observe.record("relanox_storage_stats_stale", 1);
    }
  }
  const safeRetryAccountIds = config.accounts
    .filter((a) => options.channels.get(a.id)?.capabilities.idempotentSend)
    .map((a) => a.id);
  async function invoke(work: DueWork): Promise<DispatchResult | SendResult> {
    const controller = new AbortController();
    const operationName = work.kind === "dispatch" ? "dispatch" : "send";
    const span = observe.span(
      operationName,
      { plugin: "core", operation: operationName },
      work.kind === "dispatch" ? work.record.snapshot.trace : work.record.trace,
    );
    const startedAt = Date.now();
    let successful = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<DispatchResult | SendResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ status: "unknown", errorCode: "call_timeout" });
        }, worker.callTimeoutMs);
      });
      const chunk = work.kind === "send" ? work.record.chunks[work.record.currentChunk] : undefined;
      if (work.kind === "send" && !chunk) {
        return { status: "rejected", errorCode: "invalid_chunk_index" };
      }
      let operation: Promise<DispatchResult | SendResult> | undefined;
      if (work.kind === "dispatch") {
        operation = options.agents.get(work.record.snapshot.endpoint.agent)?.dispatch({
          request: jsonSnapshot(work.record.snapshot),
          signal: controller.signal,
        });
      } else if (chunk) {
        operation = options.channels.get(work.record.target.accountId)?.send({
          deliveryId: work.record.deliveryId,
          requestId: work.record.requestId,
          target: jsonSnapshot(work.record.target),
          chunk: jsonSnapshot(chunk),
          chunkIndex: work.record.currentChunk,
          signal: controller.signal,
        });
      }
      if (!operation) {
        return { status: "rejected", errorCode: "plugin_missing" };
      }
      const result = await Promise.race([operation, timeout]);
      const valid = validateOutcome(result, work.kind);
      successful = valid.status === "sent" || valid.status === "accepted";
      return valid;
    } catch {
      return { status: "unknown", errorCode: "plugin_exception" };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      span.end(successful ? "ok" : "error");
      observe.record(
        work.kind === "dispatch"
          ? "relanox_dispatch_duration_seconds"
          : "relanox_send_duration_seconds",
        (Date.now() - startedAt) / 1000,
        { operation: operationName },
      );
    }
  }
  function canStartWork(start: number, processed: number): boolean {
    return (
      isAccepting() && processed < worker.batchSize && Date.now() - start < worker.batchDurationMs
    );
  }

  return {
    hasError: () => workerError,
    async processDue() {
      if (busy) {
        return { processed: 0, conflicts: 0 };
      }
      busy = true;
      const start = Date.now();
      let processed = 0;
      let conflicts = 0;
      try {
        while (canStartWork(start, processed)) {
          // Lease one at a time, so queued calls cannot expire behind earlier slow calls.
          const work = (
            await storage.takeDue({
              now: Date.now(),
              leaseMs: worker.leaseMs,
              limit: 1,
              leaseOwner: owner,
              safeRetryAccountIds,
            })
          )[0];
          if (!work) {
            break;
          }
          const attempts =
            work.kind === "dispatch" ? work.record.dispatch.attempts : work.record.attempts;
          let outcome: DispatchResult | SendResult =
            attempts >= worker.maxAttempts
              ? { status: "rejected", errorCode: "retry_budget_exhausted" }
              : await invoke(work);
          if (retryBudgetExhausted(outcome, attempts, worker.maxAttempts)) {
            outcome = {
              status: "rejected",
              errorCode: "retry_budget_exhausted",
            };
          }
          const now = Date.now();
          const delay = retryDelay(outcome, attempts, worker);
          const settlement =
            work.kind === "dispatch"
              ? await storage.settleAttempt({
                  kind: "dispatch",
                  id: work.record.snapshot.requestId,
                  lease: work.lease,
                  outcome: outcome as DispatchResult,
                  nextDueAt: now + delay,
                  now,
                })
              : await storage.settleAttempt({
                  kind: "send",
                  id: work.record.deliveryId,
                  lease: work.lease,
                  outcome: outcome as SendResult,
                  nextDueAt: now + delay,
                  now,
                });
          if (settlement.status !== "updated") {
            conflicts++;
          }
          processed++;
          if (work.kind === "dispatch") {
            observe.count("relanox_dispatch_total", {
              agent: work.record.snapshot.endpoint.agent,
              outcome: outcome.status,
            });
          } else {
            observe.count("relanox_delivery_total", {
              channel: work.record.target.channel,
              outcome: outcome.status,
            });
          }
          if (outcome.status === "retryable") {
            observe.count("relanox_retries_total", { operation: work.kind });
          }
          observe.log(
            outcome.status === "unknown" || outcome.status === "rejected" ? "warn" : "info",
            work.kind === "dispatch" ? "dispatch.completed" : "delivery.completed",
            {
              plugin: "core",
              operation: work.kind === "dispatch" ? "dispatch" : "send",
              requestId:
                work.kind === "dispatch" ? work.record.snapshot.requestId : work.record.requestId,
              ...(work.kind === "send" ? { deliveryId: work.record.deliveryId } : {}),
              outcome: outcome.status,
              ...("errorCode" in outcome ? { errorCode: outcome.errorCode } : {}),
            },
          );
        }
        workerError = false;
        observe.record("relanox_worker_last_success_timestamp_seconds", Date.now() / 1000);
        await refreshStats();
        return { processed, conflicts };
      } catch (error) {
        workerError = true;
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
