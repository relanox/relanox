import type { ScopedAgentHost, ConversationRecord } from '@relanox/sdk'
import type { AgentHostOptions } from './agent.js'
import { richMessage, orderedReferences, richChunks } from './rich-message.js'
import { CoreError } from '../errors.js'
import { jsonSnapshot } from '../json.js'
import { prepareMessageMedia, messageMedia } from './media.js'
import { createOperationTracer } from './tracing.js'

type MessageInput = Parameters<ScopedAgentHost['sendMessage']>[0]

export async function enqueue(
  options: AgentHostOptions,
  scope: readonly string[],
  input: MessageInput,
  conversation: ConversationRecord
): ReturnType<ScopedAgentHost['sendMessage']> {
  const { storage, worker, channels, agent, observe } = options

  const messageId = input.idempotencyKey ?? crypto.randomUUID()

  const rich = richMessage(input.text, input.attachments)

  const prepared = await prepareMessageMedia(
    storage,
    input.channel,
    messageId,
    rich.attachments,
    worker,
    input.idempotencyKey !== undefined
  )

  const now = Date.now()
  const references = orderedReferences(rich, prepared.references)

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
          chunks: richChunks(
            plugin,
            deliveryId,
            rich,
            prepared.references,
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
