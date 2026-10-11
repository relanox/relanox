import { createCore, safeObservability } from "@relanox/core";
import { createStandardObservability } from "@relanox/observability-standard";
import { noopObservability } from "@relanox/sdk";
import type { ObservabilityRuntime } from "@relanox/sdk";
import { appConfigSchema } from "./config.js";
import type { AppConfig } from "./config.js";
import { deadline } from "./deadline.js";
import { createLifecycle } from "./lifecycle.js";
import { createListeners, listen } from "./listeners.js";
import { loadPlugins } from "./plugins.js";
import { openStorage, requireHealthy, validateStorage } from "./storage.js";
import { createWorker } from "./worker.js";

const noopRuntime: ObservabilityRuntime = {
  observe: noopObservability,
  async flush() {},
  async shutdown() {},
};
export function validateApp(input: unknown): AppConfig {
  const config = appConfigSchema.parse(input);
  validateStorage(config.relay.storage);
  if (config.relay.observability.plugin === "standard") {
    createStandardObservability().validateConfig(config.relay.observability.config);
  }
  loadPlugins(config.relay);
  return config;
}
export { requireHealthy } from "./storage.js";
async function setupObservability(config: AppConfig): Promise<ObservabilityRuntime> {
  if (config.relay.observability.plugin === "none") {
    return noopRuntime;
  }
  const plugin = createStandardObservability();
  return plugin.setup(plugin.validateConfig(config.relay.observability.config));
}
/** Validation precedes side effects; register resources immediately after acquisition. */
export async function startRuntime(input: unknown) {
  const config = validateApp(input);
  const { channels, agents } = loadPlugins(config.relay);
  const lifecycle = createLifecycle(config.server.shutdownTimeoutMs, [
    ...channels.values(),
    ...agents.values(),
  ]);
  try {
    const observability = await setupObservability(config);
    lifecycle.registerObservability(observability);
    const observe = safeObservability(observability.observe);
    const storage = await openStorage(config.relay.storage, observe);
    lifecycle.registerStorage(storage);
    await storage.initialize();
    await requireHealthy(storage);
    const core = await createCore({
      config: config.relay,
      storage,
      channels,
      agents,
      observe,
      ...(config.media ? { media: config.media } : {}),
      ...(config.mediaLimits ? { worker: config.mediaLimits } : {}),
    });
    core.setAccepting(false);
    const worker = createWorker(core, config.server.workerIntervalMs, observe);
    lifecycle.registerCore(
      () => {
        core.setAccepting(false);
      },
      () => worker.stop(),
    );
    const listeners = createListeners(core, observability, lifecycle.live, () =>
      worker.healthy(config.server.workerStaleMs),
    );
    lifecycle.servers.push(listeners.business, listeners.management);
    const businessUrl = await listen(listeners.business, config.server.port, config.server.host);
    const managementUrl = await listen(
      listeners.management,
      config.server.managementPort,
      config.server.managementHost,
    );
    // A connection can receive its first message before another connection finishes starting.
    // Readiness remains gated on the worker's first successful scan.
    core.setAccepting(true);
    await deadline(
      Promise.all(
        [...channels.values(), ...agents.values()].map(async (plugin) =>
          plugin.start?.(lifecycle.signal),
        ),
      ),
      config.server.startupTimeoutMs,
    );
    worker.start();
    observe.log("info", "startup.completed", {
      plugin: "cli",
      operation: "startup",
      outcome: "ok",
    });
    return { businessUrl, managementUrl, core, stop: () => lifecycle.stop() };
  } catch (error) {
    await lifecycle.stop().catch(() => {});
    throw error;
  }
}
