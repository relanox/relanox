import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { name, subscriptionSchema } from './protocol.js'
import type { SubscriptionStore } from './subscriptions.js'

/** Check the authenticated endpoint before any messages or attachments exist. */
export function registerConnectionStatus(
  server: McpServer,
  endpointId: string,
  subscriptions: SubscriptionStore
): void {
  server.registerTool(
    'relanox_connection_status',
    {
      description:
        'Check this authenticated Relanox connection before subscribing, without any message or attachment IDs. Returns the endpoint and number of active native event subscriptions. Zero subscriptions means new messages cannot yet notify dot. This checks MCP access and subscription state, not channel delivery or whether dot has processed a message.',
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({
        endpointId: z.string(),
        eventName: z.literal(name),
        activeSubscriptions: z.number().int().nonnegative()
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const entries = await subscriptions.activeEntries(endpointId)
      const now = Date.now()

      const activeSubscriptions = entries.filter((entry) => {
        const sub = subscriptionSchema.parse(entry.value)
        return (
          sub.owner === endpointId &&
          sub.endpointId === endpointId &&
          sub.expiresAt > now
        )
      }).length

      const result = { endpointId, eventName: name, activeSubscriptions }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result
      }
    }
  )
}
