import { createStandardObservability } from '@relanox/observability-standard'
import { noopObservability } from '@relanox/sdk'
import type { ObservabilityRuntime } from '@relanox/sdk'
import type { AppConfig } from './config.js'

export function validateObservability(config: AppConfig): void {
  if (config.relay.observability.plugin === 'standard') {
    createStandardObservability().validateConfig(
      config.relay.observability.config
    )
  }
}

export async function setupObservability(
  config: AppConfig
): Promise<ObservabilityRuntime> {
  if (config.relay.observability.plugin === 'none') {
    return { observe: noopObservability, async flush() {}, async shutdown() {} }
  }
  const plugin = createStandardObservability()
  return plugin.setup(plugin.validateConfig(config.relay.observability.config))
}
