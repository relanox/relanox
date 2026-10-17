import type {
  AgentHost,
  AgentId,
  AgentPrincipal,
  ChannelPlugin,
  CommonHost,
  EndpointConfig,
  ConversationRecord,
  Observability,
  ScopedAgentHost,
  Storage
} from '@relanox/sdk'
import { z } from 'zod'
import { textId, boundedText } from '../validation.js'
import type { WorkerConfig } from '../worker/options.js'
import { createAgentMedia } from './media.js'
import { authorizedConversation } from './conversations.js'
import { channelStatus } from './status.js'
import { enqueue } from './enqueue-message.js'
import { readMessages } from './read-messages.js'
import { replyConversation } from './reply-status.js'

export type AgentHostOptions = {
  readonly agent: AgentId
  readonly agentEndpoints: readonly EndpointConfig[]
  readonly common: CommonHost
  readonly storage: Storage
  readonly observe: Observability
  readonly worker: WorkerConfig
  readonly channels: ReadonlyMap<string, ChannelPlugin<unknown>>
  readonly configured: ReadonlyMap<string, ConversationRecord>
  readonly connections: ReadonlyMap<
    string,
    'connected' | 'disconnected' | 'degraded'
  >
}

/** Authenticated endpoints send to current configured conversations. */
export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { agent, agentEndpoints, common, storage, worker } = options
  return {
    ...common,
    forPrincipal(principal: AgentPrincipal): ScopedAgentHost {
      textId.parse(principal.subject)

      const scope = [...new Set(principal.endpointIds)].filter((id) =>
        agentEndpoints.some((endpoint) => endpoint.id === id)
      )

      return {
        readMessages: async (input) => readMessages(options, scope, input),
        ...(storage.media
          ? {
              media: createAgentMedia(
                storage,
                agent,
                scope,
                worker,
                options.configured
              )
            }
          : {}),
        status: async (input) => channelStatus(options, scope, input),
        async sendMessage(input) {
          textId.parse(input.channel)
          if (input.reply) {
            z.strictObject({
              requestId: textId,
              kind: z.enum(['progress', 'final'])
            }).parse(input.reply)
          }
          if (input.idempotencyKey !== undefined) {
            textId.parse(input.idempotencyKey)
          }
          boundedText(
            input.text,
            worker.maxTextBytes,
            !input.attachments?.length
          )
          const conversation = await storage.getConversation(input.channel)
          if (
            !authorizedConversation(
              conversation,
              agent,
              scope,
              options.configured
            )
          ) {
            return { status: 'not_found' }
          }

          const destination = input.reply
            ? await replyConversation(
                options,
                conversation,
                input.reply.requestId
              )
            : conversation

          if (!destination) {
            return { status: 'not_found' }
          }
          return enqueue(options, scope, input, destination)
        }
      }
    }
  }
}
