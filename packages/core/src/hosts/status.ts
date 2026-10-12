import type {
  AgentChannelStatus,
  AgentStatus,
  ChannelPlugin,
  ConversationRecord
} from '@relanox/sdk'
import type { AgentHostOptions } from './agent.js'
import { authorizedConversation } from './conversations.js'
import { textId } from '../validation.js'

async function channelView(
  options: AgentHostOptions,
  conversation: ConversationRecord,
  plugin: ChannelPlugin<unknown>,
  mediaLimits: AgentStatus['mediaLimits']
): Promise<AgentChannelStatus> {
  const capabilities = plugin.capabilities

  const resolution = await plugin.resolveChannel?.(
    conversation.address,
    conversation.target
  )

  return {
    channel: conversation.address,
    connection:
      options.connections.get(`channels/${conversation.address.accountId}`) ??
      'connected',
    send:
      resolution?.status === 'available'
        ? { status: 'available' }
        : {
            status: 'unavailable',
            reason: resolution?.reason ?? 'address_unresolved'
          },
    media: options.storage.media ? (capabilities.media?.send ?? []) : [],
    maxTextLength: capabilities.maxTextLength,
    lengthUnit: capabilities.lengthUnit,
    ...(capabilities.maxTextLengthPerMessage === undefined
      ? {}
      : { maxTextLengthPerMessage: capabilities.maxTextLengthPerMessage }),
    ...(capabilities.maxChunksPerMessage === undefined
      ? {}
      : { maxChunksPerMessage: capabilities.maxChunksPerMessage }),
    maxAttachments: Math.min(
      mediaLimits.maxAttachments,
      capabilities.maxAttachmentsPerMessage ?? Infinity
    )
  }
}

async function deliveryView(
  options: AgentHostOptions,
  scope: readonly string[],
  id: string
): Promise<AgentStatus['delivery']> {
  textId.parse(id)
  const delivery = await options.storage.getOutbound(id)

  const conversation = delivery
    ? await options.storage.getConversation(delivery.channelId)
    : undefined

  if (
    !delivery ||
    !authorizedConversation(
      conversation,
      options.agent,
      scope,
      options.configured
    )
  ) {
    return undefined
  }
  return {
    id: delivery.deliveryId,
    channel: delivery.channelId,
    status: delivery.status,
    ...(delivery.errorCode === undefined
      ? {}
      : { errorCode: delivery.errorCode })
  }
}

export async function channelStatus(
  options: AgentHostOptions,
  scope: readonly string[],
  deliveryId?: string
): Promise<AgentStatus> {
  const channels: AgentChannelStatus[] = []

  const mediaLimits = options.storage.media
    ? {
        maxBytes: options.worker.maxMediaBytes,
        maxTotalBytes: options.worker.maxTotalMediaBytes,
        maxAttachments: options.worker.maxAttachments
      }
    : { maxBytes: 0, maxTotalBytes: 0, maxAttachments: 0 }

  for (const current of options.configured.values()) {
    const conversation = await options.storage.getConversation(
      current.address.id
    )

    if (
      !authorizedConversation(
        conversation,
        options.agent,
        scope,
        options.configured
      )
    ) {
      continue
    }
    const plugin = options.channels.get(current.address.accountId)
    if (plugin) {
      channels.push(
        await channelView(options, conversation, plugin, mediaLimits)
      )
    }
  }

  const delivery =
    deliveryId === undefined
      ? undefined
      : await deliveryView(options, scope, deliveryId)

  return { channels, mediaLimits, ...(delivery ? { delivery } : {}) }
}
