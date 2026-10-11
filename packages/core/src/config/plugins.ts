import type { RelanoxConfig } from '@relanox/sdk'
import type { CoreOptions } from '../types.js'
import { CoreError } from '../errors.js'
import { jsonSnapshot } from '../json.js'
import { chunkText } from '../chunk.js'
import { bindingKey } from './relations.js'

/** No setup is allowed until every configured plugin has accepted its configuration. */
export function validatePluginConfigurations(
  options: Pick<CoreOptions, 'channels' | 'agents'>,
  config: RelanoxConfig
) {
  const accountValidated = new Map<string, unknown>()
  // Validate every endpoint before setup can register a live route. Keep ORIGINAL JSON in snapshots.
  for (const account of config.accounts) {
    const plugin = options.channels.get(account.id)
    if (
      !plugin ||
      plugin.channel !== account.channel ||
      plugin.sdkMajor !== 1 ||
      plugin.runtime !== 'node'
    ) {
      throw new CoreError('channel_plugin_mismatch')
    }
    chunkText(
      '',
      plugin.capabilities.maxTextLength,
      plugin.capabilities.lengthUnit
    )
    accountValidated.set(
      account.id,
      plugin.validateConfig(jsonSnapshot(account.config))
    )
  }
  for (const endpoint of config.endpoints) {
    const plugin = options.agents.get(endpoint.agent)
    if (
      !plugin ||
      plugin.agent !== endpoint.agent ||
      plugin.sdkMajor !== 1 ||
      plugin.runtime !== 'node'
    ) {
      throw new CoreError('agent_plugin_mismatch')
    }
    plugin.validateConfig(jsonSnapshot(endpoint.config))
  }

  return {
    accountValidated,
    endpoints: new Map(
      config.endpoints.map((endpoint) => [endpoint.id, endpoint])
    ),
    bindings: new Map(
      config.bindings.map((binding) => [
        bindingKey(binding.accountId, binding.chatId, binding.threadId),
        binding
      ])
    )
  }
}
