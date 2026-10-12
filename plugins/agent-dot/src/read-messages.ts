import type { McpServer } from '@modelcontextprotocol/server'
import type { ScopedAgentHost } from '@relanox/sdk'
import { agentRequestSchema, projectAgentRequest } from '@relanox/agent-mcp'
import { z } from 'zod'

export const dotMessageSchema = agentRequestSchema.extend({
  requestId: z.string(),
  acceptedAt: z.number().int().nonnegative()
})

export function registerReadMessages(
  server: McpServer,
  host: ScopedAgentHost
): void {
  server.registerTool(
    'relanox_read_messages',
    {
      description:
        'Recover persisted incoming messages when event data is missing. Supply requestId from data or remove the evt_ prefix from eventId. Without an ID, inspect up to limit recent messages (default 5, maximum 20), newest first. Results may include already processed messages; this read does not claim, acknowledge or replay work. Match the event before replying. Empty results mean missing, expired or unauthorized content.',
      inputSchema: z.strictObject({
        requestId: z.string().min(1).max(512).optional(),
        limit: z.number().int().min(1).max(20).optional()
      }),
      outputSchema: z.strictObject({ messages: z.array(dotMessageSchema) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      const records = await host.readMessages({
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        ...(input.limit === undefined ? {} : { limit: input.limit })
      })

      const result = {
        messages: records.map((record) =>
          Object.assign(projectAgentRequest(record), {
            requestId: record.requestId,
            acceptedAt: record.acceptedAt
          })
        )
      }

      return {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }]
      }
    }
  )
}
