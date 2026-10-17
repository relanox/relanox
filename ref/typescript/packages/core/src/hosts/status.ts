import type {
  AgentChannelStatus,
  AgentStatus,
  ChannelPlugin,
  ConversationRecord,
  ScopedAgentHost
} from '@relanox/sdk'
import type { AgentHostOptions } from './agent.js'
import { authorizedConversation } from './conversations.js'
import { replyStatus } from './reply-status.js'
import { textId } from '../validation.js'

function richTextMode(
  plugin: ChannelPlugin<unknown>
): NonNullable<AgentChannelStatus['richText']> {
  if (plugin.capabilities.richText) {
    return 'native'
  }
  if (!plugin.capabilities.media?.send.length) {
    return 'text-only'
  }
  return plugin.channel === 'wecom' && plugin.capabilities.transport === 'http'
    ? 'text-then-images'
    : 'sequential'
}

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
    richText: richTextMode(plugin),
    ...(capabilities.richText ? { richTextLimits: capabilities.richText } : {}),
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
  input?: Parameters<ScopedAgentHost['status']>[0]
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

  const deliveryId = input?.deliveryId

  const delivery =
    deliveryId === undefined
      ? undefined
      : await deliveryView(options, scope, deliveryId)

  const request =
    input?.requestId === undefined
      ? undefined
      : await requestView(options, scope, input.requestId)

  return {
    channels,
    mediaLimits,
    ...(delivery ? { delivery } : {}),
    ...(request ? { request } : {})
  }
}

async function requestView(
  options: AgentHostOptions,
  scope: readonly string[],
  id: string
): Promise<AgentStatus['request']> {
  textId.parse(id)
  const record = await options.storage.getInbound(id)
  if (!record) {
    return undefined
  }

  const conversation = await options.storage.getConversation(
    record.snapshot.channel.id
  )

  if (
    !authorizedConversation(
      conversation,
      options.agent,
      scope,
      options.configured
    ) ||
    record.snapshot.endpoint.id !== conversation.endpoint.id
  ) {
    return undefined
  }
  return { id, reply: await replyStatus(options.storage, record) }
}
