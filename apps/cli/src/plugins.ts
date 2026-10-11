import { createDotAgentPlugin } from "@relanox/agent-dot";
import { createGrokAgentPlugin } from "@relanox/agent-grok";
import type { AgentId, AgentPlugin, ChannelId, ChannelPlugin, RelanoxConfig } from "@relanox/sdk";
import { createTelegramChannel } from "@relanox/channel-telegram";
import { createFeishuChannel } from "@relanox/channel-feishu";
import { createTeamsChannel } from "@relanox/channel-msteams";
import { createWhatsAppChannel } from "@relanox/channel-whatsapp";
import { createGoogleChatChannel } from "@relanox/channel-googlechat";
import { createLineChannel } from "@relanox/channel-line";

import { createDiscordChannel } from "@relanox/channel-discord";
import { createSlackChannel } from "@relanox/channel-slack";
import { createWeComChannel } from "@relanox/channel-wecom";
import { createDingTalkChannel } from "@relanox/channel-dingtalk";
import { createQqChannel } from "@relanox/channel-qq";
import { createMatrixChannel } from "@relanox/channel-matrix";
import { createMattermostChannel } from "@relanox/channel-mattermost";
import { createSignalChannel } from "@relanox/channel-signal";
import { createIrcChannel } from "@relanox/channel-irc";

const channelFactories: Record<ChannelId, () => ChannelPlugin<unknown>> = {
  telegram: createTelegramChannel,
  discord: createDiscordChannel,
  slack: createSlackChannel,
  feishu: createFeishuChannel,
  wecom: createWeComChannel,
  dingtalk: createDingTalkChannel,
  qq: createQqChannel,
  msteams: createTeamsChannel,
  whatsapp: createWhatsAppChannel,
  matrix: createMatrixChannel,
  googlechat: createGoogleChatChannel,
  line: createLineChannel,
  mattermost: createMattermostChannel,
  signal: createSignalChannel,
  irc: createIrcChannel,
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
