import type { McpServer } from '@modelcontextprotocol/server'
import type { ScopedAgentHost } from '@relanox/sdk'
import {
  agentRequestSchema,
  projectAgentRequest,
  replyStatusSchema
} from '@relanox/agent-mcp'
import { z } from 'zod'

export const dotMessageSchema = agentRequestSchema.extend({
  requestId: z.string(),
  acceptedAt: z.number().int().nonnegative()
})

const cursorSchema = z.strictObject({
  acceptedAt: z.number().int().nonnegative(),
  requestId: z.string().min(1).max(512)
})

export function registerReadMessages(
  server: McpServer,
  host: ScopedAgentHost
): void {
  server.registerTool(
    'relanox_read_messages',
    {
      description:
        'Recover persisted incoming messages when event data is missing. Supply requestId from data or remove the evt_ prefix from eventId. Without an ID, inspect up to limit recent messages (default 5, maximum 20), newest first; pending=true instead pages retained unfinished work oldest first, with nextCursor. Only awaiting_final needs an answer. Existing pending/rejected/unknown final deliveries must not generate a new answer; inspect their deliveryId. Expired content is excluded; status(requestId) reports expired. Reads are snapshots, so check status again before sending. Results may include already processed messages; this read does not claim, acknowledge or replay work. Match the event before replying. Empty results mean missing, expired or unauthorized content.',
      inputSchema: z.strictObject({
        requestId: z.string().min(1).max(512).optional(),
        pending: z
          .boolean()
          .optional()
          .describe(
            'Read retained unfinished messages, oldest first. Excludes expired and fully sent requests. Does not claim or resend work.'
          ),
        cursor: cursorSchema
          .optional()
          .describe(
            'Use nextCursor from a pending page. Continue until it is absent. Never combine pending with requestId.'
          ),
        limit: z.number().int().min(1).max(20).optional()
      }),
      outputSchema: z.strictObject({
        nextCursor: cursorSchema.optional(),
        messages: z.array(
          dotMessageSchema.extend({ reply: replyStatusSchema.optional() })
        )
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      const records = await host.readMessages({
        ...(input.pending === undefined ? {} : { pending: input.pending }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        ...(input.limit === undefined ? {} : { limit: input.limit })
      })

      const last = records.at(-1)

      const nextCursor =
        input.pending && last && records.length === (input.limit ?? 5)
          ? { acceptedAt: last.acceptedAt, requestId: last.requestId }
          : undefined

      const result = {
        ...(nextCursor ? { nextCursor } : {}),
        messages: records.map((record) =>
          Object.assign(projectAgentRequest(record), {
            reply: record.reply,
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
