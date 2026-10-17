import type {
  ConversationRecord,
  InboundRecord,
  ReplyStatus,
  Storage
} from '@relanox/sdk'
import type { AgentHostOptions } from './agent.js'
import { canonicalJson } from '../json.js'
import { isFiltered } from '@relanox/sdk'

/** Bind an explicit reply to its original native context, even after newer input arrives. */
export async function replyConversation(
  options: AgentHostOptions,
  conversation: ConversationRecord,
  requestId: string
): Promise<ConversationRecord | undefined> {
  const record = await options.storage.getInbound(requestId)
  if (
    !record ||
    isFiltered(record) ||
    record.snapshot.channel.id !== conversation.address.id ||
    canonicalJson(record.snapshot.endpoint) !==
      canonicalJson(conversation.endpoint)
  ) {
    return undefined
  }
  return { ...conversation, target: record.snapshot.target }
}

export async function replyStatus(
  storage: Storage,
  record: InboundRecord
): Promise<ReplyStatus> {
  if (isFiltered(record)) {
    return { status: 'rejected', errorCode: 'middleware_filtered' }
  }
  const deliveryId = record.reply?.finalDeliveryId
  if (deliveryId) {
    const delivery = await storage.getOutbound(deliveryId)
    return {
      status: delivery?.status ?? 'unknown',
      deliveryId,
      ...(delivery?.errorCode ? { errorCode: delivery.errorCode } : {})
    }
  }
  return {
    status: record.redactedAt === undefined ? 'awaiting_final' : 'expired'
  }
}
