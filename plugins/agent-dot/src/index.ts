import type { AgentPlugin } from '@relanox/sdk'
import { configSchema } from './config.js'
import type { DotConfig } from './config.js'
import { createDispatch } from './dispatch.js'
import { createEventsHandler } from './events.js'
import { createSubscriptions } from './subscriptions.js'

export type { DotConfig } from './config.js'

export function createDotAgentPlugin(): AgentPlugin<DotConfig> {
  let dispatch: AgentPlugin<DotConfig>['dispatch'] | undefined
  const handlers: ReturnType<typeof createEventsHandler>[] = []
  return {
    id: 'agent-dot',
    kind: 'agent',
    agent: 'dot',
    sdkMajor: 1,
    runtime: 'node',
    validateConfig(config) {
      return configSchema.parse(config)
    },
    async setup(agentHost, endpoints) {
      const configured = new Map(
        endpoints.map((endpoint) => [
          endpoint.id,
          configSchema.parse(endpoint.config)
        ])
      )

      const subscriptions = createSubscriptions(agentHost.state)
      dispatch = createDispatch(agentHost.state, configured, subscriptions)
      for (const endpoint of endpoints) {
        const config = configured.get(endpoint.id)
        if (!config) {
          throw new Error('agent_config_missing')
        }

        const handler = createEventsHandler(
          agentHost,
          endpoint,
          config,
          subscriptions
        )

        handlers.push(handler)
        agentHost.mountHttp(`/mcp/${endpoint.id}`, handler.fetch)
      }
    },
    async dispatch(input) {
      if (!dispatch) {
        throw new Error('agent_not_setup')
      }
      return dispatch(input)
    },
    async stop() {
      await Promise.all(handlers.map((handler) => handler.close()))
    }
  }
}
