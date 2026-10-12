import type { ChannelId, EndpointConfig } from './config.js'
import type { ReplyTarget, DeliveryStatus } from './messages.js'
import type { MediaKind } from './media.js'

/** A configured conversation or thread, authorized through its Agent endpoint. */
export type ChannelAddress = {
  readonly id: string
  readonly platform: ChannelId
  readonly accountId: string
  readonly chatId: string
  readonly threadId?: string
}

/** Native context is learned only from authenticated channel input. */
export type ConversationRecord = {
  readonly address: ChannelAddress
  readonly endpoint: EndpointConfig
  readonly target?: ReplyTarget
}

/** Availability is a snapshot; native delivery must recheck expiring capabilities. */
export type ChannelResolution =
  | { readonly status: 'available'; readonly target: ReplyTarget }
  | { readonly status: 'unavailable'; readonly reason: string }

export type AgentChannelStatus = {
  readonly channel: ChannelAddress
  readonly connection: 'connected' | 'disconnected' | 'degraded'
  readonly send:
    | { readonly status: 'available' }
    | { readonly status: 'unavailable'; readonly reason: string }
  readonly media: readonly MediaKind[]
  readonly maxTextLength: number
  readonly maxAttachments?: number
}

export type AgentStatus = {
  readonly channels: readonly AgentChannelStatus[]
  readonly delivery?: {
    readonly id: string
    readonly channel: string
    readonly status: DeliveryStatus
    readonly errorCode?: string
  }
}

/** Durable channel authorization and learned native addresses, independent of messages. */
export type ConversationStorage = {
  registerConversations(records: readonly ConversationRecord[]): Promise<void>
  getConversation(id: string): Promise<ConversationRecord | undefined>
}
