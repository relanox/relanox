import type {
  AccountConfig,
  Binding,
  ChannelHost,
  CommonHost,
  EndpointConfig,
  IngestInput,
  Observability,
  Storage,
  MediaKind,
  ChannelMediaHost
} from '@relanox/sdk'
import type { WorkerConfig } from '../worker/options.js'
import { bindingKey } from '../config/relations.js'
import { CoreError } from '../errors.js'
import { jsonSnapshot } from '../json.js'
import { ingestSchema, boundedText } from '../validation.js'
import { inboundMedia } from '../media.js'
import { conversationAddress } from './conversations.js'
import { createOperationTracer } from './tracing.js'

type ChannelHostOptions = {
  readonly mediaPublisher?: ChannelMediaHost
  readonly account: AccountConfig
  readonly bindings: ReadonlyMap<string, Binding>
  readonly endpoints: ReadonlyMap<string, EndpointConfig>
  readonly common: CommonHost
  readonly storage: Storage
  readonly observe: Observability
  readonly worker: WorkerConfig
  readonly mediaKinds?: readonly MediaKind[]
  isAccepting(this: void): boolean
}

/** Authorizes sender and conversation before persisting the immutable inbound snapshot. */
export function createChannelHost({
  account,
  mediaPublisher,
  bindings,
  endpoints,
  common,
  storage,
  observe,
  worker,
  mediaKinds,
  isAccepting
}: ChannelHostOptions): ChannelHost {
  const traced = createOperationTracer(observe)
  return {
    ...common,
    boundChatIds: Object.freeze([
      ...new Set(
        [...bindings.values()]
          .filter((binding) => binding.accountId === account.id)
          .map((binding) => binding.chatId)
      )
    ]),
    ...(mediaPublisher ? { media: mediaPublisher } : {}),
    maxMediaBytes: worker.maxMediaBytes,
    async ingest(input: IngestInput) {
      const { attachments, ...message } = input
      if (!isAccepting()) {
        throw new CoreError('not_accepting')
      }
      ingestSchema.parse(message)
      boundedText(input.text, worker.maxTextBytes, !attachments?.length)
      if (
        input.source.accountId !== account.id ||
        input.target.accountId !== account.id ||
        input.source.channel !== account.channel ||
        input.target.channel !== account.channel
      ) {
        throw new CoreError('account_scope_mismatch')
      }
      if (
        new TextEncoder().encode(
          JSON.stringify([input.context, input.target.data])
        ).length > worker.maxContextBytes
      ) {
        throw new CoreError('context_too_large')
      }

      const binding = bindings.get(
        bindingKey(account.id, input.target.chatId, input.target.threadId)
      )

      if (!binding) {
        throw new CoreError('unbound_conversation')
      }
      if (
        !account.allowedSenders.includes(input.senderId) ||
        (binding.allowedSenders &&
          !binding.allowedSenders.includes(input.senderId))
      ) {
        throw new CoreError('sender_not_allowed')
      }
      const endpoint = endpoints.get(binding.endpointId)
      if (!endpoint) {
        throw new CoreError('unbound_endpoint')
      }

      const media = inboundMedia(
        attachments,
        worker.maxMediaBytes,
        worker.maxAttachments,
        Boolean(storage.media),
        worker.maxTotalMediaBytes
      )

      if (media.some((item) => !mediaKinds?.includes(item.reference.kind))) {
        throw new CoreError('media_not_supported')
      }

      const receipt = await traced(
        'ingest',
        async (trace) =>
          storage.acceptInbound(
            jsonSnapshot({
              ...message,
              ...(media.length > 0
                ? { attachments: media.map((item) => item.reference) }
                : {}),
              ...(trace ? { trace } : {}),
              requestId: crypto.randomUUID(),
              channel: conversationAddress(binding, endpoint, account.channel),
              endpoint,
              acceptedAt: Date.now()
            }),
            media
          ),
        input.trace
      )

      observe.count('relanox_inbound_total', {
        channel: account.channel,
        outcome: receipt.duplicate ? 'duplicate' : 'accepted'
      })
      observe.log(
        'info',
        receipt.duplicate ? 'inbound.duplicate' : 'inbound.accepted',
        {
          plugin: 'core',
          requestId: receipt.requestId,
          outcome: receipt.duplicate ? 'duplicate' : 'accepted'
        }
      )
      return receipt
    }
  }
}

export { configuredConversations } from './conversations.js'
