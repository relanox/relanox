import type {
  AgentId,
  AgentPlugin,
  ChannelPlugin,
  StoragePlugin,
  ObservabilityPlugin
} from '@relanox/sdk'
import { appConfigSchema } from './config.js'
import type { AppConfig } from './config.js'
import { createPluginLoader } from './plugin-loader.js'
import { loadPlugins } from './plugins.js'
import { loadMiddleware } from './middleware.js'

export async function assemble(input: unknown): Promise<{
  config: AppConfig
  middlewareRegistry: Awaited<ReturnType<typeof loadMiddleware>>
  storagePlugin: StoragePlugin<unknown>
  storageConfig: unknown
  observabilityPlugin: ObservabilityPlugin<unknown> | undefined
  observabilityConfig: unknown
  channels: Map<string, ChannelPlugin<unknown>>
  agents: Map<AgentId, AgentPlugin<unknown>>
}> {
  const config = appConfigSchema.parse(input)
  const loader = await createPluginLoader(config.plugins)

  const storagePlugin = await loader.load(
    'storage',
    config.relay.storage.plugin
  )

  if (storagePlugin.kind !== 'storage') {
    throw new Error('plugin_kind_mismatch')
  }

  const storageConfig = storagePlugin.validateConfig(
    config.relay.storage.config
  )

  const observabilityPlugin =
    config.relay.observability.plugin === 'none'
      ? undefined
      : await loader.load('observability', 'standard')

  if (observabilityPlugin && observabilityPlugin.kind !== 'observability') {
    throw new Error('plugin_kind_mismatch')
  }

  const observabilityConfig = observabilityPlugin?.validateConfig(
    config.relay.observability.config
  )

  const middlewareRegistry = await loadMiddleware(config.middleware, loader)
  const middleware = middlewareRegistry.configSchema.parse(config.middleware)
  const plugins = await loadPlugins(config.relay, loader)
  return {
    config: { ...config, middleware: [...middleware] },
    middlewareRegistry,
    storagePlugin,
    storageConfig,
    observabilityPlugin,
    observabilityConfig,
    ...plugins
  }
}
