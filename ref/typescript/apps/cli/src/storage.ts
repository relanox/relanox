import { noopObservability } from '@relanox/sdk'
import type { Observability, RelanoxConfig, Storage } from '@relanox/sdk'
import { createPluginLoader } from './plugin-loader.js'
import type { PluginConfig } from './plugin-config.js'

export async function requireHealthy(storage: Storage): Promise<void> {
  if (!(await storage.health()).ok) {
    throw new Error('storage_unavailable')
  }
}

export async function openStorage(
  config: RelanoxConfig['storage'],
  observe: Observability = noopObservability,
  plugins: PluginConfig = {}
): Promise<Storage> {
  const loader = await createPluginLoader(plugins)
  const plugin = await loader.load('storage', config.plugin)
  if (plugin.kind !== 'storage') {
    throw new Error('plugin_kind_mismatch')
  }
  return plugin.setup(plugin.validateConfig(config.config), observe)
}
