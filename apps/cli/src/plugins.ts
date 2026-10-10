import { createDotAgentPlugin } from "@relanox/agent-dot";
import { createGrokAgentPlugin } from "@relanox/agent-grok";
import { createDiscordChannel } from "@relanox/channel-discord";
import { createDingTalkChannel } from "@relanox/channel-dingtalk";
import { createFeishuChannel } from "@relanox/channel-feishu";
import { createSlackChannel } from "@relanox/channel-slack";
import { createTelegramChannel } from "@relanox/channel-telegram";
import { createWeComChannel } from "@relanox/channel-wecom";
import { createQqChannel } from "@relanox/channel-qq";
import type { AgentId, AgentPlugin, ChannelId, ChannelPlugin, RelanoxConfig } from "@relanox/sdk";

const channelFactories: Partial<Record<ChannelId, () => ChannelPlugin<unknown>>> = {
  telegram: createTelegramChannel,
  discord: createDiscordChannel,
  slack: createSlackChannel,
  feishu: createFeishuChannel,
  wecom: createWeComChannel,
  dingtalk: createDingTalkChannel,
  qq: createQqChannel,
};
const agentFactories: Record<AgentId, () => AgentPlugin<unknown>> = {
  dot: createDotAgentPlugin,
  grok: createGrokAgentPlugin,
};
export function loadPlugins(config: RelanoxConfig) {
  const channels = new Map<string, ChannelPlugin<unknown>>();
  for (const account of config.accounts) {
    const factory = channelFactories[account.channel];
    if (!factory) {
      throw new Error("channel_unavailable");
    }
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
