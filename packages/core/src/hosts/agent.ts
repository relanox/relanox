import type {
  AgentHost,
  AgentId,
  AgentPrincipal,
  ChannelPlugin,
  CommonHost,
  DeliveryChunk,
  EndpointConfig,
  ConversationRecord,
  Observability,
  ReplyTarget,
  ScopedAgentHost,
  Storage,
  StoredMedia
} from '@relanox/sdk'
import { splitMarkdown, textLength } from '@relanox/markdown'
import { CoreError } from '../errors.js'
import { jsonSnapshot } from '../json.js'
import { textId, boundedText } from '../validation.js'
import type { WorkerConfig } from '../worker/options.js'
import { createAgentMedia, prepareMessageMedia, messageMedia } from './media.js'
import { authorizedConversation } from './conversations.js'
import { channelStatus } from './status.js'
import { createOperationTracer } from './tracing.js'

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

type MessageInput = Parameters<ScopedAgentHost['sendMessage']>[0]

function chunksFor(
  plugin: ChannelPlugin<unknown>,
  deliveryId: string,
  text: string,
  media: readonly StoredMedia[],
  target: ReplyTarget
): readonly DeliveryChunk[] {
  if (
    media.length > (plugin.capabilities.maxAttachmentsPerMessage ?? Infinity) ||
    media.some(
      (item) => !plugin.capabilities.media?.send.includes(item.reference.kind)
    )
  ) {
    throw new CoreError('media_not_supported')
  }

  if (
    textLength(text, plugin.capabilities.lengthUnit) >
    (plugin.capabilities.maxTextLengthPerMessage ?? Infinity)
  ) {
    throw new CoreError('reply_exceeds_channel_limit')
  }

  const chunks: DeliveryChunk[] = (
    text
      ? (plugin.splitText?.(text, target) ??
        splitMarkdown(text, {
          maxLength: plugin.capabilities.maxTextLength,
          unit: plugin.capabilities.lengthUnit
        }))
      : []
  ).map((part, index) => ({
    text: part,
    idempotencyKey: `${deliveryId}:${index}`,
    state: null
  }))

  const result = [
    ...chunks,
    ...media.map((item, index) => ({
      text: '',
      media: item.reference,
      idempotencyKey: `${deliveryId}:${chunks.length + index}`,
      state: null
    }))
  ]

  if (result.length > (plugin.capabilities.maxChunksPerMessage ?? Infinity)) {
    throw new CoreError('reply_exceeds_channel_limit')
  }
  return result
}

async function enqueue(
  options: AgentHostOptions,
  scope: readonly string[],
  input: MessageInput,
  conversation: ConversationRecord
): ReturnType<ScopedAgentHost['sendMessage']> {
  const { storage, worker, channels, agent, observe } = options

  const messageId = input.idempotencyKey ?? crypto.randomUUID()

  const prepared = await prepareMessageMedia(
    storage,
    input.channel,
    messageId,
    input.attachments,
    worker,
    input.idempotencyKey !== undefined
  )

  const now = Date.now()
  const references = prepared.references

  const message = {
    messageId,
    text: input.text,
    ...(references.length > 0 ? { attachments: references } : {}),
    createdAt: now
  }

  if (input.idempotencyKey !== undefined) {
    const receipt = await storage.getMessageReceipt({
      channelId: input.channel,
      endpointIds: scope,
      agent,
      message
    })

    if (receipt.status !== 'not_found') {
      return receipt
    }
  }
  const media = await messageMedia(storage, input.channel, prepared, worker)
  const plugin = channels.get(conversation.address.accountId)
  if (!plugin) {
    throw new CoreError('channel_plugin_missing')
  }
  const deliveryId = crypto.randomUUID()

  const resolution = await plugin.resolveChannel?.(
    conversation.address,
    conversation.target
  )

  if (resolution?.status !== 'available') {
    throw new CoreError('channel_unavailable')
  }
  const target = resolution.target

  const result = await createOperationTracer(observe)(
    'enqueue_message',
    async () =>
      storage.enqueueMessage({
        channelId: input.channel,
        endpointIds: scope,
        agent,
        message,
        media: media.stored,
        maxCount: worker.maxAttachments * 2,
        maxTotalBytes: worker.maxTotalMediaBytes * 2,
        outbound: {
          deliveryId,
          channelId: input.channel,
          messageId,
          endpoint: conversation.endpoint,
          target: jsonSnapshot(target),
          chunks: chunksFor(
            plugin,
            deliveryId,
            input.text,
            media.attachments,
            target
          ),
          currentChunk: 0,
          receipts: [],
          status: 'pending',
          version: 1,
          attempts: 0,
          dueAt: now,
          createdAt: now
        }
      })
  )

  observe.log('info', 'message.queued', {
    plugin: 'core',
    channelId: input.channel,
    outcome: result.status === 'queued' ? 'ok' : result.status
  })
  return result
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
        status: async (input) =>
          channelStatus(options, scope, input?.deliveryId),
        async sendMessage(input) {
          textId.parse(input.channel)
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
          return enqueue(options, scope, input, conversation)
        }
      }
    }
  }
}
