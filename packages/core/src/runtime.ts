import { Hono } from "hono";
import type { CoreOptions, CoreRuntime } from "./types.js";
import { validateConfig } from "./config/index.js";
import { jsonSnapshot } from "./json.js";
import { safeObservability } from "./observe.js";
import { createAdministration } from "./administration.js";
import { workerSchema } from "./worker/options.js";
import { createWorker } from "./worker/runtime.js";
import { createHttpHandler } from "./http.js";
import { setupPluginHosts } from "./hosts/setup.js";

/** Composes the relay; listeners, timers, and plugin lifecycle belong to the CLI. */
export async function createCore(options: CoreOptions): Promise<CoreRuntime> {
  const config = validateConfig(options.config);
  const storage = options.storage;
  const observe = safeObservability(options.observe);
  const workerOptions = workerSchema.parse(options.worker ?? {});
  const app = new Hono();
  const connections = new Map<string, "connected" | "disconnected" | "degraded">();
  let accepting = true;
  const isAccepting = () => accepting;
  await setupPluginHosts(options, config, workerOptions, observe, app, isAccepting, connections);
  app.onError(() => Response.json({ error: "internal_error" }, { status: 500 }));
  const worker = createWorker(options, config, workerOptions, observe, isAccepting);
  const administration = createAdministration(storage, connections);
  return {
    config: jsonSnapshot(config),
    fetch: createHttpHandler(app, workerOptions, observe),
    processDue: () => worker.processDue(),
    ...administration,
    async readiness() {
      const status = await administration.health();
      if (!status.ok) {
        return status;
      }
      if (!accepting) {
        return { ok: false, errorCode: "not_accepting" };
      }
      if (worker.hasError()) {
        return { ok: false, errorCode: "worker_failed" };
      }
      return { ok: true };
    },
    setAccepting(value) {
      accepting = value;
    },
  };
}
