import type { CoreRuntime } from "@relanox/core";
import type { Observability } from "@relanox/sdk";

/** Schedule the next batch only after settlement, so slow batches never accumulate. */
export function createWorker(core: CoreRuntime, intervalMs: number, observe: Observability) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let working = Promise.resolve();
  let stopping = false;
  let failed = false;
  let lastSuccess = 0;
  const tick = async () => {
    try {
      await core.processDue();
      lastSuccess = Date.now();
      failed = false;
      observe.record("relanox_worker_last_success_timestamp_seconds", lastSuccess / 1000);
    } catch {
      failed = true;
      observe.log("error", "operation.failed", {
        plugin: "cli",
        operation: "worker",
        errorCode: "storage",
      });
    } finally {
      if (!stopping) {
        timer = setTimeout(() => {
          working = tick();
        }, intervalMs);
      }
    }
  };
  return {
    async start() {
      working = tick();
      await working;
    },
    healthy(staleMs: number) {
      return !stopping && !failed && lastSuccess > 0 && Date.now() - lastSuccess <= staleMs;
    },
    stop() {
      stopping = true;
      clearTimeout(timer);
      return working;
    },
  };
}
