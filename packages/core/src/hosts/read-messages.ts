import { z } from 'zod'
import type { AgentMessage, InboundRecord, ScopedAgentHost } from '@relanox/sdk'
import type { AgentHostOptions } from './agent.js'
import { authorizedConversation } from './conversations.js'
import { textId } from '../validation.js'

const inputSchema = z.strictObject({
  requestId: textId.optional(),
  limit: z.number().int().min(1).max(20).default(5)
})

export async function readMessages(
  options: AgentHostOptions,
  scope: readonly string[],
  input: Parameters<ScopedAgentHost['readMessages']>[0]
): Promise<readonly AgentMessage[]> {
  const { requestId, limit } = inputSchema.parse(input ?? {})

  const records =
    requestId === undefined
      ? (
          await Promise.all(
            scope.map(async (endpointId) =>
              options.storage.listInbound({ endpointId, limit, recent: true })
            )
          )
        ).flat()
      : [await options.storage.getInbound(requestId)].filter(
          (record): record is InboundRecord => record !== undefined
        )

  return records
    .filter(
      (record) =>
        record.redactedAt === undefined &&
        authorizedConversation(
          {
            address: record.snapshot.channel,
            endpoint: record.snapshot.endpoint
          },
          options.agent,
          scope,
          options.configured
        )
    )
    .toSorted(
      (a, b) =>
        b.snapshot.acceptedAt - a.snapshot.acceptedAt ||
        b.snapshot.requestId.localeCompare(a.snapshot.requestId)
    )
    .slice(0, limit)
    .map(({ snapshot }) => projectMessage(snapshot))
}

function projectMessage(snapshot: AgentMessage): AgentMessage {
  return {
    requestId: snapshot.requestId,
    acceptedAt: snapshot.acceptedAt,
    channel: snapshot.channel,
    senderId: snapshot.senderId,
    text: snapshot.text,
    context: snapshot.context,
    ...(snapshot.attachments ? { attachments: snapshot.attachments } : {})
  }
}
