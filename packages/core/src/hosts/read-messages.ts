import { z } from 'zod'
import { needsTranscription } from '@relanox/sdk'
import type { AgentMessage, InboundRecord, ScopedAgentHost } from '@relanox/sdk'
import type { AgentHostOptions } from './agent.js'
import { authorizedConversation } from './conversations.js'
import { replyStatus } from './reply-status.js'
import { textId } from '../validation.js'
import { preparedRequest } from '../speech.js'

const inputSchema = z
  .strictObject({
    requestId: textId.optional(),
    pending: z.boolean().default(false),
    cursor: z
      .strictObject({
        acceptedAt: z.number().int().nonnegative(),
        requestId: textId
      })
      .optional(),
    limit: z.number().int().min(1).max(20).default(5)
  })
  .refine(
    (input) =>
      !(input.requestId && input.pending) &&
      (input.cursor === undefined || input.pending),
    'cursor requires pending; requestId cannot be combined with pending'
  )

export async function readMessages(
  options: AgentHostOptions,
  scope: readonly string[],
  input: Parameters<ScopedAgentHost['readMessages']>[0]
): Promise<readonly AgentMessage[]> {
  const parsed = inputSchema.parse(input ?? {})
  const { requestId, limit } = parsed
  if (parsed.pending) {
    return readPending(options, scope, parsed)
  }

  const records =
    requestId === undefined
      ? (
          await Promise.all(
            scope.map(async (endpointId) =>
              options.storage.listInbound({
                endpointId,
                limit,
                recent: true,
                readyOnly: true
              })
            )
          )
        ).flat()
      : [await options.storage.getInbound(requestId)].filter(
          (record): record is InboundRecord => record !== undefined
        )

  const visible = records
    .filter(
      (record) =>
        record.redactedAt === undefined &&
        !needsTranscription(record) &&
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

  return Promise.all(
    visible.map(async (record) =>
      Object.assign(projectMessage(preparedRequest(record)), {
        reply: await replyStatus(options.storage, record)
      })
    )
  )
}

function projectMessage(snapshot: AgentMessage): AgentMessage {
  return {
    requestId: snapshot.requestId,
    acceptedAt: snapshot.acceptedAt,
    channel: snapshot.channel,
    senderId: snapshot.senderId,
    text: snapshot.text,
    context: snapshot.context,
    ...(snapshot.transcriptions
      ? { transcriptions: snapshot.transcriptions }
      : {}),
    ...(snapshot.attachments ? { attachments: snapshot.attachments } : {})
  }
}

async function readPending(
  options: AgentHostOptions,
  scope: readonly string[],
  input: z.infer<typeof inputSchema>
): Promise<readonly AgentMessage[]> {
  const channelIds = [...options.configured.values()]
    .filter((conversation) =>
      authorizedConversation(
        conversation,
        options.agent,
        scope,
        options.configured
      )
    )
    .map((conversation) => conversation.address.id)

  const records = await options.storage.listPendingInbound({
    channelIds,
    endpointIds: scope,
    limit: input.limit,
    ...(input.cursor ? { cursor: input.cursor } : {})
  })

  return Promise.all(
    records.map(async (record) =>
      Object.assign(projectMessage(preparedRequest(record)), {
        reply: await replyStatus(options.storage, record)
      })
    )
  )
}
