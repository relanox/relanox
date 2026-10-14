import { createCore, safeObservability } from '@relanox/core'
import { setupObservability, validateObservability } from './observability.js'
import { appConfigSchema } from './config.js'
import type { AppConfig } from './config.js'
import { deadline } from './deadline.js'
import { createLifecycle } from './lifecycle.js'
import { createListeners, listen } from './listeners.js'
import { loadPlugins } from './plugins.js'
import { openStorage, requireHealthy, validateStorage } from './storage.js'
import { createWorker } from './worker.js'
import { tencentSpeechPlugin } from '@relanox/speech-tencent'

export function validateApp(input: unknown): AppConfig {
  const config = appConfigSchema.parse(input)
  validateStorage(config.relay.storage)
  validateObservability(config)
  loadPlugins(config.relay)
  return config
}

export { requireHealthy } from './storage.js'

/** Validation precedes side effects; register resources immediately after acquisition. */
export async function startRuntime(input: unknown): Promise<{
  businessUrl: Awaited<ReturnType<typeof listen>>
  managementUrl: Awaited<ReturnType<typeof listen>>
  core: Awaited<ReturnType<typeof createCore>>
  stop(this: void): Promise<void>
}> {
  const config = validateApp(input)

  const speechToText = config.speechToText
    ? await tencentSpeechPlugin.setup(config.speechToText.config)
    : undefined

  const { channels, agents } = loadPlugins(config.relay)

  const lifecycle = createLifecycle(config.server.shutdownTimeoutMs, [
    ...channels.values(),
    ...agents.values()
  ])

  try {
    const observability = await setupObservability(config)
    lifecycle.registerObservability(observability)
    const observe = safeObservability(observability.observe)
    const storage = await openStorage(config.relay.storage, observe)
    lifecycle.registerStorage(storage)
    await storage.initialize()
    await requireHealthy(storage)

    const core = await createCore({
      config: config.relay,
      storage,
      channels,
      agents,
      observe,
      ...(speechToText ? { speechToText } : {}),
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
