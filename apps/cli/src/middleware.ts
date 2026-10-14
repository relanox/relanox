import type { MiddlewarePlugin } from '@relanox/sdk'
import type { AppConfig } from './config.js'
import type { PluginLoader } from './plugins.js'
import { createMiddlewareRegistry } from './middleware-registry.js'

/** Configuration selects both the installed implementation and execution order. */
export async function loadMiddleware(
  config: AppConfig['middleware'],
  loader: PluginLoader
): Promise<ReturnType<typeof createMiddlewareRegistry>> {
  const plugins: MiddlewarePlugin<unknown>[] = []
  for (const entry of config) {
    const plugin = await loader.load('middleware', entry.plugin)
    if (plugin.kind !== 'middleware') {
      throw new Error('plugin_kind_mismatch')
    }
    plugins.push(plugin)
  }
  return createMiddlewareRegistry(plugins)
}
