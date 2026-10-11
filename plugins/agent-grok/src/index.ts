import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import type { AgentPlugin } from '@relanox/sdk'
import { configSchema } from './config.js'
import type { GrokConfig } from './config.js'
import {
  createMediaTransport,
  guard,
  registerTools,
  equalSecret,
  resolveAgentSecret,
  agentInstructions
} from '@relanox/agent-mcp'
import { dispatchRoutine } from './routine.js'

export type { GrokConfig } from './config.js'

export function createGrokAgentPlugin(): AgentPlugin<GrokConfig> {
  const handlers: ReturnType<typeof createMcpHandler>[] = []
  return {
    id: 'agent-grok',
    kind: 'agent',
    agent: 'grok',
    sdkMajor: 1,
    runtime: 'node',
    validateConfig(config) {
      return configSchema.parse(config)
    },
    async setup(host, endpoints) {
      if (host.publicUrl === undefined) {
        throw new Error('public_url_required')
      }
      const publicUrl = host.publicUrl
      for (const endpoint of endpoints) {
        const config = configSchema.parse(endpoint.config)

        const scopedHost = host.forPrincipal({
          subject: endpoint.id,
          endpointIds: [endpoint.id]
        })

        const media = createMediaTransport(
          scopedHost,
          config.mcp,
          endpoint.id,
          'grok',
          publicUrl
        )

        if (media.maxBytes > 0) {
          host.mountHttp(`/media/${endpoint.id}/*`, media.fetch, {
            maxBodyBytes: media.maxBytes,
            authorize: media.authorize
          })
        }

        // Official stateless legacy and modern compatibility.
        const handler = createMcpHandler(() => {
          const server = new McpServer(
            { name: 'relanox-grok', version: '0.1.0' },
            {
              instructions: agentInstructions('grok')
            }
          )

          registerTools(server, scopedHost)
          media.register(server)
          return server
        })

        handlers.push(handler)

        const authenticatePath = async (
          request: Request
        ): Promise<Response | undefined> => {
          const prefix = `/agents/grok/mcp/${endpoint.id}/`
          const pathname = new URL(request.url).pathname
          let token: string | undefined
          if (pathname.startsWith(prefix)) {
            const segment = pathname.slice(prefix.length)
            if (segment.length > 0 && !segment.includes('/')) {
              try {
                token = decodeURIComponent(segment)
              } catch {
                // Malformed URL encoding is an invalid credential.
              }
            }
          }
          return token !== undefined &&
            equalSecret(token, resolveAgentSecret(config.mcp.token))
            ? undefined
            : Response.json({ error: 'unauthorized' }, { status: 401 })
        }

        const fetch = async (request: Request): Promise<Response> => {
          const checked = await guard(
            request,
            config.mcp,
            publicUrl,
            config.mcp.auth === 'path' ? authenticatePath : undefined
          )

          return checked instanceof Response ? checked : handler.fetch(checked)
        }

        host.mountHttp(`/mcp/${endpoint.id}`, fetch)
        if (config.mcp.auth === 'path') {
          host.mountHttp(`/mcp/${endpoint.id}/*`, fetch)
        }
      }
    },
    dispatch: dispatchRoutine,
    async stop() {
      await Promise.all(handlers.map(async (handler) => handler.close()))
    }
  }
}
