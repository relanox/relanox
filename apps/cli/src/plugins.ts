import type {
  AgentId,
  AgentPlugin,
  ChannelPlugin,
  RelanoxConfig
} from '@relanox/sdk'
import type { createPluginLoader } from './plugin-loader.js'

export type PluginLoader = Awaited<ReturnType<typeof createPluginLoader>>

export async function loadPlugins(
  config: RelanoxConfig,
  loader: PluginLoader
): Promise<{
  channels: Map<string, ChannelPlugin<unknown>>
  agents: Map<AgentId, AgentPlugin<unknown>>
}> {
  const channels = new Map<string, ChannelPlugin<unknown>>()
  for (const account of config.accounts) {
    const plugin = await loader.load('channel', account.channel)
    if (plugin.kind !== 'channel') {
      throw new Error('plugin_kind_mismatch')
    }
    plugin.validateConfig(account.config)
    channels.set(account.id, plugin)
  }
  const agents = new Map<AgentId, AgentPlugin<unknown>>()
  for (const endpoint of config.endpoints) {
    let plugin = agents.get(endpoint.agent)
    if (!plugin) {
      const loaded = await loader.load('agent', endpoint.agent)
      if (loaded.kind !== 'agent') {
        throw new Error('plugin_kind_mismatch')
      }
      plugin = loaded
      agents.set(endpoint.agent, plugin)
    }
    plugin.validateConfig(endpoint.config)
  }
  return { channels, agents }
}
