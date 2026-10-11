import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import type { ServerCapabilities } from '@modelcontextprotocol/server'
import type { AgentHost, EndpointConfig } from '@relanox/sdk'
import { z } from 'zod'
import type { DotConfig } from './config.js'
import {
  createMediaTransport,
  guard,
  agentInstructions,
  registerTools,
  agentRequestSchema
} from '@relanox/agent-mcp'
import {
  args,
  name,
  requestMetadata,
  subscribeParams,
  unsubscribeParams
} from './protocol.js'
import type { SubscriptionStore } from './subscriptions.js'
import { mountOAuth } from './oauth/index.js'

export function createEventsHandler(
  agentHost: AgentHost,
  endpoint: EndpointConfig,
  config: DotConfig,
  subscriptions: SubscriptionStore
): {
  fetch(this: void, request: Request): Promise<Response>
  close(this: void): Promise<void>
} {
  if (agentHost.publicUrl === undefined) {
    throw new Error('public_url_required')
  }
  const publicUrl = agentHost.publicUrl

  const authenticate =
    config.mcp.auth === 'oauth'
      ? mountOAuth(agentHost, endpoint.id, config)
      : undefined

  const scopedHost = agentHost.forPrincipal({
    subject: endpoint.id,
    endpointIds: [endpoint.id]
  })

  const media = createMediaTransport(
    scopedHost,
    config.mcp,
    endpoint.id,
    'dot',
    publicUrl
  )

  if (media.maxBytes > 0) {
    agentHost.mountHttp(`/media/${endpoint.id}/*`, media.fetch, {
      maxBodyBytes: media.maxBytes,
      authorize: media.authorize
    })
  }

  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: 'relanox-dot', version: '0.1.0' },
        {
          capabilities: { events: {} } as ServerCapabilities,
          instructions: agentInstructions('dot')
        }
      )

      registerTools(server, scopedHost)
      media.register(server)
      server.server.setRequestHandler(
        'events/list',
        {
          params: z.strictObject({
            cursor: z.null().optional(),
            _meta: requestMetadata
          }),
          result: z.strictObject({
            events: z.array(z.record(z.string(), z.json()))
          })
        },
        async () => ({
          events: [
            {
              name,
              description:
                'A persisted message is available in the authenticated Relanox endpoint; the payload contains the complete message to process.',
              delivery: ['webhook'],
              inputSchema: z.json().parse(z.toJSONSchema(args)),
              payloadSchema: z.json().parse(z.toJSONSchema(agentRequestSchema))
            }
          ]
        })
      )
      server.server.setRequestHandler(
        'events/subscribe',
        {
          params: subscribeParams,
          result: z.strictObject({
            id: z.string(),
            refreshBefore: z.string(),
            cursor: z.null(),
            truncated: z.boolean()
          })
        },
        async (input) => subscriptions.subscribe(endpoint, input)
      )
      server.server.setRequestHandler(
        'events/unsubscribe',
        { params: unsubscribeParams, result: z.strictObject({}) },
        async (input) => subscriptions.unsubscribe(endpoint, input)
      )
      return server
    },
    { legacy: 'reject' }
  )

  const fetch = async (request: Request): Promise<Response> => {
    const checked = await guard(request, config.mcp, publicUrl, authenticate)
    if (checked instanceof Response) {
      return checked
    }

    const response = await handler.fetch(checked)

    // SDK 2.3.1 strips draft Events and OpenAI tool auth metadata from its wire schemas.
    // Preserve SDK negotiation/validation, augment only successful discovery results.
    if (
      response.headers.get('content-type')?.includes('application/json') ===
      true
    ) {
      const body = (await response.clone().json()) as {
        result?: {
          supportedVersions?: string[]
          capabilities?: Record<string, unknown>
          tools?: {
            _meta?: Record<string, unknown>
            securitySchemes?: unknown
          }[]
        }
      }

      let changed = false
      if (
        body.result?.supportedVersions?.includes('2026-07-28') === true &&
        body.result.capabilities
      ) {
        body.result.capabilities.events = {}
        changed = true
      }
      if (authenticate && body.result?.tools) {
        const securitySchemes = [{ type: 'oauth2', scopes: ['relanox'] }]
        for (const tool of body.result.tools) {
          const { _meta: metadata } = tool
          Object.assign(tool, {
            securitySchemes,
            _meta: { ...metadata, securitySchemes }
          })
        }
        changed = true
      }
      if (changed) {
        const headers = new Headers(response.headers)
        headers.delete('content-length')
        return Response.json(body, { status: response.status, headers })
      }
    }
    return response
  }

  return { fetch, close: async () => handler.close() }
}
