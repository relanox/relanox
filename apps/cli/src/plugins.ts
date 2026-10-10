import { createDotAgentPlugin } from "@relanox/agent-dot";
import { createGrokAgentPlugin } from "@relanox/agent-grok";
import type { AgentId, AgentPlugin, ChannelId, ChannelPlugin, RelanoxConfig } from "@relanox/sdk";
import { httpChannelFactories } from "./http-channels.js";
import { connectedChannelFactories } from "./connected-channels.js";

const channelFactories: Record<ChannelId, () => ChannelPlugin<unknown>> = {
  ...httpChannelFactories,
  ...connectedChannelFactories,
};
const agentFactories: Record<AgentId, () => AgentPlugin<unknown>> = {
  dot: createDotAgentPlugin,
  grok: createGrokAgentPlugin,
};
export function loadPlugins(config: RelanoxConfig) {
  const channels = new Map<string, ChannelPlugin<unknown>>();
  for (const account of config.accounts) {
    const factory = channelFactories[account.channel];
    const plugin = factory();
    plugin.validateConfig(account.config);
    channels.set(account.id, plugin);
  }
  const agents = new Map<AgentId, AgentPlugin<unknown>>();
  for (const endpoint of config.endpoints) {
    let plugin = agents.get(endpoint.agent);
    if (!plugin) {
      plugin = agentFactories[endpoint.agent]();
      agents.set(endpoint.agent, plugin);
    }
    plugin.validateConfig(endpoint.config);
  }
  return { channels, agents };
}
