import type { RelanoxConfig, Observability } from "@relanox/sdk";
import type { CoreOptions } from "../types.js";
import type { WorkerConfig } from "../worker/options.js";
import { CoreError } from "../errors.js";
import { jsonSnapshot } from "../json.js";
import type { Hono } from "hono";
import { validatePluginConfigurations } from "../config/plugins.js";
import { createCommonHostFactory } from "./common.js";
import { createChannelHost } from "./channel.js";
import { createAgentHost } from "./agent.js";

/** Validate the complete plugin graph before any setup callback can mount a route. */
export async function setupPluginHosts(
  options: CoreOptions,
  config: RelanoxConfig,
  worker: WorkerConfig,
  observe: Observability,
  app: Hono,
  isAccepting: () => boolean,
  connections: Map<string, "connected" | "disconnected" | "degraded">,
): Promise<void> {
  const storage = options.storage;
  const common = createCommonHostFactory(storage, observe, app, isAccepting, connections);
  const { accountValidated, endpoints, bindings } = validatePluginConfigurations(
    options,
    config,
    connections,
  );

  for (const account of config.accounts) {
    const plugin = options.channels.get(account.id);
    if (!plugin) {
      throw new CoreError("channel_plugin_mismatch");
    }
    const host = createChannelHost({
      account,
      bindings,
      endpoints,
      common: common({ pluginId: plugin.id, ownerId: account.id }, `/channels/${account.id}`),
      storage,
      observe,
      worker,
      isAccepting,
    });
    await plugin.setup(host, jsonSnapshot(account), accountValidated.get(account.id));
  }
  for (const agent of new Set(config.endpoints.map((endpoint) => endpoint.agent))) {
    const plugin = options.agents.get(agent);
    if (!plugin) {
      throw new CoreError("agent_plugin_mismatch");
    }
    const agentEndpoints = config.endpoints.filter((endpoint) => endpoint.agent === agent);
    const host = createAgentHost({
      agent,
      agentEndpoints,
      common: common({ pluginId: plugin.id, ownerId: agent }, `/agents/${agent}`),
      storage,
      observe,
      worker,
      channels: options.channels,
    });
    await plugin.setup(host, jsonSnapshot(agentEndpoints), {});
  }
}
