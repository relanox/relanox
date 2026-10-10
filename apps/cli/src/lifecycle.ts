import type { Server } from "node:http";
import type { Lifecycle, ObservabilityRuntime, Storage } from "@relanox/sdk";
import { deadline } from "./deadline.js";
import { closeServer } from "./listeners.js";

export function createLifecycle(timeoutMs: number, plugins: readonly Lifecycle[]) {
  const abort = new AbortController();
  const servers: Server[] = [];
  let storage: Storage | undefined;
  let observability: ObservabilityRuntime | undefined;
  let stopWorker = async () => {};
  let stopAccepting = () => {};
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let deadlineAt = 0;
  const remaining = () => Math.max(0, deadlineAt - Date.now());
  const attempt = async (action: () => Promise<void>): Promise<boolean> => {
    try {
      await deadline(action(), remaining());
      return true;
    } catch {
      return false;
    }
  };
  return {
    signal: abort.signal,
    servers,
    live: () => !stopping,
    registerStorage(resource: Storage) {
      storage = resource;
    },
    registerObservability(resource: ObservabilityRuntime) {
      observability = resource;
    },
    registerCore(setAccepting: () => void, worker: () => Promise<void>) {
      stopAccepting = setAccepting;
      stopWorker = worker;
    },
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        deadlineAt = Date.now() + timeoutMs;
        stopping = true;
        stopAccepting();
        abort.abort();
        const draining = await Promise.all([
          attempt(stopWorker),
          ...servers.map((server) => attempt(() => closeServer(server))),
          ...plugins.map((plugin) => attempt(async () => plugin.stop?.())),
        ]);
        for (const server of servers) {
          server.closeAllConnections();
        }
        const closedStorage = await attempt(async () => storage?.close());
        const closedObserve = await attempt(async () =>
          observability?.shutdown(AbortSignal.timeout(remaining())),
        );
        if (!closedStorage || !closedObserve || draining.includes(false)) {
          throw new Error("shutdown_incomplete");
        }
      })();
      return stopPromise;
    },
  };
}
