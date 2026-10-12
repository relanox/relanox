import { canonicalJson } from '../json.js'
import { createHash } from 'node:crypto'
import type {
  AgentId,
  Binding,
  ChannelAddress,
  ConversationRecord,
  EndpointConfig,
  RelanoxConfig
} from '@relanox/sdk'

/** Endpoint ownership is part of identity, so rebinding never exposes old media. */
export function conversationAddress(
  binding: Binding,
  endpoint: EndpointConfig,
  platform: ChannelAddress['platform']
): ChannelAddress {
  const id = createHash('sha256')
    .update(
      canonicalJson([
        platform,
        binding.accountId,
        binding.chatId,
        binding.threadId ?? null,
        endpoint
      ])
    )
    .digest('hex')

  return {
    id,
    platform,
    accountId: binding.accountId,
    chatId: binding.chatId,
    ...(binding.threadId === undefined ? {} : { threadId: binding.threadId })
  }
}

export function configuredConversations(
  config: RelanoxConfig
): readonly ConversationRecord[] {
  return config.bindings.map((binding) => {
    const endpoint = config.endpoints.find(
      (item) => item.id === binding.endpointId
    )

    const account = config.accounts.find(
      (item) => item.id === binding.accountId
    )

    if (!endpoint || !account) {
      throw new Error('Invalid conversation binding')
    }
    return {
      address: conversationAddress(binding, endpoint, account.channel),
      endpoint
    }
  })
}

export function authorizedConversation(
  record: ConversationRecord | undefined,
  agent: AgentId,
  scope: readonly string[],
  configured: ReadonlyMap<string, ConversationRecord>
): record is ConversationRecord {
  const current = record ? configured.get(record.address.id) : undefined
  return (
    current !== undefined &&
    canonicalJson(current.address) === canonicalJson(record?.address) &&
    current.endpoint.agent === agent &&
    scope.includes(current.endpoint.id) &&
    canonicalJson(current.endpoint) === canonicalJson(record?.endpoint)
  )
}
