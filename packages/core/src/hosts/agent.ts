import { createHash } from 'node:crypto'
import type {
  AgentHost,
  AgentId,
  AgentPrincipal,
  ChannelPlugin,
  CommonHost,
  DeliveryChunk,
  EndpointConfig,
  InboundRecord,
  Observability,
  ScopedAgentHost,
  Storage,
  StoredMedia
} from '@relanox/sdk'
import { chunkText } from '../chunk.js'
import { CoreError } from '../errors.js'
import { jsonSnapshot } from '../json.js'
import { textId, boundedText } from '../validation.js'
import type { WorkerConfig } from '../worker/options.js'
import { createAgentMedia, messageMedia, authorizedRequest } from './media.js'
import { createOperationTracer } from './tracing.js'

type AgentHostOptions = {
  readonly agent: AgentId
  readonly agentEndpoints: readonly EndpointConfig[]
  readonly common: CommonHost
  readonly storage: Storage
  readonly observe: Observability
  readonly worker: WorkerConfig
  readonly channels: ReadonlyMap<string, ChannelPlugin<unknown>>
}

type MessageInput = Parameters<ScopedAgentHost['sendMessage']>[0]

function chunksFor(
  plugin: ChannelPlugin<unknown>,
  deliveryId: string,
  text: string,
  media: readonly StoredMedia[]
): readonly DeliveryChunk[] {
  if (
    media.length > (plugin.capabilities.maxAttachmentsPerMessage ?? Infinity) ||
    media.some(
      (item) => !plugin.capabilities.media?.send.includes(item.reference.kind)
    )
  ) {
    throw new CoreError('media_not_supported')
  }

  const chunks: DeliveryChunk[] = (
    text
      ? chunkText(
          text,
          plugin.capabilities.maxTextLength,
          plugin.capabilities.lengthUnit
        )
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
  request: InboundRecord
): ReturnType<ScopedAgentHost['sendMessage']> {
  const { storage, worker, channels, agent, observe } = options

  const media = await messageMedia(
    storage,
    input.replyTo,
    input.attachments,
    worker
  )

  const plugin = channels.get(request.snapshot.target.accountId)
  if (!plugin) {
    throw new CoreError('channel_plugin_missing')
  }
  const deliveryId = crypto.randomUUID()
  const now = Date.now()
  const references = media.attachments.map((item) => item.reference)

  const messageId =
    input.idempotencyKey ??
    createHash('sha256')
      .update(JSON.stringify([input.text, references]))
      .digest('hex')

  const result = await createOperationTracer(observe)(
    'enqueue_message',
    async () =>
      storage.enqueueMessage({
        requestId: input.replyTo,
        endpointIds: scope,
        agent,
        message: {
          messageId,
          text: input.text,
          ...(references.length > 0 ? { attachments: references } : {}),
          createdAt: now
        },
        media: media.stored,
        maxCount: worker.maxAttachments * 2,
        maxTotalBytes: worker.maxTotalMediaBytes * 2,
        outbound: {
          deliveryId,
          requestId: input.replyTo,
          messageId,
          target: jsonSnapshot(request.snapshot.target),
          chunks: chunksFor(plugin, deliveryId, input.text, media.attachments),
          currentChunk: 0,
          receipts: [],
          status: 'pending',
          version: 1,
          attempts: 0,
          dueAt: now,
          createdAt: now,
          ...(request.snapshot.trace ? { trace: request.snapshot.trace } : {})
        }
      }),
    request.snapshot.trace
  )

  if (result.status === 'queued' && !result.replay) {
    observe.record(
      'relanox_reply_duration_seconds',
      Math.max(0, (now - request.snapshot.acceptedAt) / 1000),
      { agent }
    )
  }
  observe.log('info', 'message.queued', {
    plugin: 'core',
    requestId: input.replyTo,
    outcome: result.status === 'queued' ? 'ok' : result.status
  })
  return result
}

/** Authenticated endpoints can send messages only to the frozen incoming reply address. */
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
        media: createAgentMedia(storage, agent, scope, worker),
        async sendMessage(input) {
          textId.parse(input.replyTo)
          if (input.idempotencyKey !== undefined) {
            textId.parse(input.idempotencyKey)
          }
          boundedText(
            input.text,
            worker.maxTextBytes,
            !input.attachments?.length
          )
          const request = await storage.getInbound(input.replyTo)
          if (!authorizedRequest(request, agent, scope)) {
            return { status: 'not_found' }
          }
          return enqueue(options, scope, input, request)
        }
      }
    }
  }
}
