import { createCore, safeObservability } from '@relanox/core'
import { noopObservability } from '@relanox/sdk'
import type {
  AgentId,
  AgentPlugin,
  ChannelPlugin,
  StoragePlugin,
  ObservabilityPlugin,
  ObservabilityRuntime
} from '@relanox/sdk'
import { appConfigSchema } from './config.js'
import type { AppConfig } from './config.js'
import { deadline } from './deadline.js'
import { createLifecycle } from './lifecycle.js'
import { createListeners, listen } from './listeners.js'
import { loadPlugins } from './plugins.js'
import { requireHealthy } from './storage.js'
import { createPluginLoader } from './plugin-loader.js'
import { createWorker } from './worker.js'

const noopRuntime: ObservabilityRuntime = {
  observe: noopObservability,
  async flush() {},
  async shutdown() {}
}

async function assemble(input: unknown): Promise<{
  config: AppConfig
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

  const plugins = await loadPlugins(config.relay, loader)
  return {
    config,
    storagePlugin,
    storageConfig,
    observabilityPlugin,
    observabilityConfig,
    ...plugins
  }
}

export async function validateApp(input: unknown): Promise<AppConfig> {
  return (await assemble(input)).config
}

export { requireHealthy } from './storage.js'

/** Validation precedes side effects; register resources immediately after acquisition. */
export async function startRuntime(input: unknown): Promise<{
  businessUrl: Awaited<ReturnType<typeof listen>>
  managementUrl: Awaited<ReturnType<typeof listen>>
  core: Awaited<ReturnType<typeof createCore>>
  stop(this: void): Promise<void>
}> {
  const {
    config,
    channels,
    agents,
    storagePlugin,
    storageConfig,
    observabilityPlugin,
    observabilityConfig
  } = await assemble(input)

  const lifecycle = createLifecycle(config.server.shutdownTimeoutMs, [
    ...channels.values(),
    ...agents.values()
  ])

  try {
    const observability = observabilityPlugin
      ? await observabilityPlugin.setup(observabilityConfig)
      : noopRuntime

    lifecycle.registerObservability(observability)
    const observe = safeObservability(observability.observe)
    const storage = await storagePlugin.setup(storageConfig, observe)
    lifecycle.registerStorage(storage)
    await storage.initialize()
    await requireHealthy(storage)

    const core = await createCore({
      config: config.relay,
      storage,
      channels,
      agents,
      observe,
      ...(config.publicUrl === undefined
        ? {}
        : { publicUrl: config.publicUrl }),
      ...(config.media ? { media: config.media } : {}),
      ...(config.mediaLimits ? { worker: config.mediaLimits } : {})
    })

    core.setAccepting(false)
    const worker = createWorker(core, observe)
    lifecycle.registerCore(
      () => {
        core.setAccepting(false)
      },
      async () => worker.stop()
    )

    const listeners = createListeners(core, observability, lifecycle.live, () =>
      worker.healthy()
    )

    lifecycle.servers.push(listeners.business, listeners.management)

    const businessUrl = await listen(
      listeners.business,
      config.server.port,
      config.server.host
    )

    const managementUrl = await listen(
      listeners.management,
      config.server.managementPort,
      config.server.managementHost
    )

    // A connection can receive its first message before another connection finishes starting.
    // Readiness remains gated on the worker's first successful scan.
    core.setAccepting(true)
    await deadline(
      Promise.all(
        [...channels.values(), ...agents.values()].map(async (plugin) =>
          plugin.start?.(lifecycle.signal)
        )
      ),
      config.server.startupTimeoutMs
    )
    worker.start()
    observe.log('info', 'startup.completed', {
      plugin: 'cli',
      operation: 'startup',
      outcome: 'ok'
    })
    return {
      businessUrl,
      managementUrl,
      core,
      stop: async () => lifecycle.stop()
    }
  } catch (error) {
    await lifecycle.stop().catch(() => {})
    throw error
  }
}
