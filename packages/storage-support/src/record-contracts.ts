import type {
  ConversationRecord,
  InboundSnapshot,
  OutboundRecord,
  Lease,
  Storage
} from '@relanox/sdk'
import { equalDurableValues } from './record-codec.js'

/** Core owns the rendered chunk plan; storage validates scope, identity and publication state. */
export function matchesInitialMessage(
  outbound: OutboundRecord,
  conversation: ConversationRecord,
  input: Parameters<Storage['enqueueMessage']>[0]
): boolean {
  return (
    outbound.channelId === input.channelId &&
    outbound.messageId === input.message.messageId &&
    outbound.createdAt === input.message.createdAt &&
    equalDurableValues(outbound.endpoint, conversation.endpoint) &&
    targetMatchesConversation(outbound.target, conversation) &&
    outbound.currentChunk === 0 &&
    outbound.receipts.length === 0 &&
    outbound.status === 'pending' &&
    outbound.version === 1 &&
    outbound.attempts === 0 &&
    outbound.lease === undefined &&
    outbound.chunks.length > 0 &&
    outbound.chunks.every(
      (chunk) => chunk.media === undefined || chunk.text === ''
    ) &&
    equalDurableValues(
      outbound.chunks.flatMap((chunk) => (chunk.media ? [chunk.media] : [])),
      input.message.attachments ?? []
    )
  )
}

export const isConversationInScope = (
  record: ConversationRecord,
  input: Pick<Parameters<Storage['enqueueMessage']>[0], 'endpointIds' | 'agent'>
): boolean =>
  input.endpointIds.includes(record.endpoint.id) &&
  record.endpoint.agent === input.agent

export function targetMatchesConversation(
  target: OutboundRecord['target'],
  conversation: ConversationRecord
): boolean {
  const address = conversation.address
  return (
    target.channel === address.platform &&
    target.accountId === address.accountId &&
    target.chatId === address.chatId &&
    target.threadId === address.threadId
  )
}

export function validConversationInbound(
  snapshot: InboundSnapshot,
  conversation: ConversationRecord | undefined
): conversation is ConversationRecord {
  return (
    conversation !== undefined &&
    equalDurableValues(snapshot.channel, conversation.address) &&
    equalDurableValues(snapshot.endpoint, conversation.endpoint) &&
    targetMatchesConversation(snapshot.target, conversation) &&
    snapshot.source.channel === conversation.address.platform &&
    snapshot.source.accountId === conversation.address.accountId
  )
}

export const isActiveLease = (
  storedLease: Lease | undefined,
  attemptLease: Lease,
  now: number
): boolean =>
  storedLease !== undefined &&
  equalDurableValues(storedLease, attemptLease) &&
  storedLease.expiresAt > now
