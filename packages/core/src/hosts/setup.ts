import type {
  RelanoxConfig,
  Observability,
  HttpRouteOptions
} from '@relanox/sdk'
import type { CoreOptions } from '../types.js'
import type { WorkerConfig } from '../worker/options.js'
import { CoreError } from '../errors.js'
import { jsonSnapshot } from '../json.js'
import type { Hono } from 'hono'
import { validatePluginConfigurations } from '../config/plugins.js'
import { createCommonHostFactory } from './common.js'
import { createChannelHost, configuredConversations } from './channel.js'
import { createAgentHost } from './agent.js'

type HostSetupOptions = {
  readonly options: Pick<
    CoreOptions,
    'storage' | 'channels' | 'agents' | 'media' | 'publicUrl' | 'speechToText'
  >
  readonly config: RelanoxConfig
  readonly worker: WorkerConfig
  readonly observe: Observability
  readonly app: Hono
  readonly httpRoutes: Map<string, HttpRouteOptions>
  readonly connections: Map<string, 'connected' | 'disconnected' | 'degraded'>
  isAccepting(this: void): boolean
}

/** Validate the complete plugin graph before any setup callback can mount a route. */
export async function setupPluginHosts({
  options,
  config,
  worker,
  observe,
  app,
  httpRoutes,
  isAccepting,
  connections
}: HostSetupOptions): Promise<void> {
  const storage = options.storage

  const { common, mediaPublisher } = createCommonHostFactory(
    storage,
    observe,
    app,
    isAccepting,
    connections,
    httpRoutes,
    options.publicUrl,
    options.media,
    worker.maxMediaBytes
  )

  const { accountValidated, endpoints, bindings } =
    validatePluginConfigurations(options, config)

  const conversations = configuredConversations(config)
  await storage.registerConversations(conversations)

  const configured = new Map(
    conversations.map((record) => [record.address.id, record])
  )

  // Populate every connection before setup callbacks can report aggregate plugin health.
  for (const account of config.accounts) {
    if (options.channels.get(account.id)?.capabilities.transport !== 'http') {
      connections.set(`channels/${account.id}`, 'disconnected')
    }
  }

  for (const account of config.accounts) {
    const plugin = options.channels.get(account.id)
    if (!plugin) {
      throw new CoreError('channel_plugin_mismatch')
    }

    const host = createChannelHost({
      account,
      ...(options.speechToText ? { speechToText: options.speechToText } : {}),
      ...(mediaPublisher ? { mediaPublisher: mediaPublisher(account.id) } : {}),
      mediaKinds: plugin.capabilities.media?.receive ?? [],
      bindings,
      endpoints,
      common: common(
        { pluginId: plugin.id, ownerId: account.id },
        `/channels/${account.id}`
      ),
      storage,
      observe,
      worker,
      isAccepting
    })

    await plugin.setup(
      host,
      jsonSnapshot(account),
      accountValidated.get(account.id)
    )
  }
  for (const agent of new Set(
    config.endpoints.map((endpoint) => endpoint.agent)
  )) {
    const plugin = options.agents.get(agent)
    if (!plugin) {
      throw new CoreError('agent_plugin_mismatch')
    }

    const agentEndpoints = config.endpoints.filter(
      (endpoint) => endpoint.agent === agent
    )

    const host = createAgentHost({
      agent,
      agentEndpoints,
      common: common(
        { pluginId: plugin.id, ownerId: agent },
        `/agents/${agent}`
      ),
      storage,
      observe,
      worker,
      channels: options.channels,
      configured,
      connections
    })

    await plugin.setup(host, jsonSnapshot(agentEndpoints), {})
  }
}
