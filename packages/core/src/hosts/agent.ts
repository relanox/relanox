import type {
  AgentHost,
  AgentId,
  AgentPrincipal,
  ChannelPlugin,
  CommonHost,
  EndpointConfig,
  Json,
  Observability,
  ScopedAgentHost,
  Storage
} from '@relanox/sdk'
import { z } from 'zod'
import { chunkText } from '../chunk.js'
import { CoreError } from '../errors.js'
import { jsonSnapshot } from '../json.js'
import { textId, limit, boundedText } from '../validation.js'
import type { WorkerConfig } from '../worker/options.js'
import {
  createAgentMedia,
  completionMedia,
  authorizedRequest
} from './media.js'
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

/** Intersects authenticated endpoint authority and keeps result destinations inside saved snapshots. */
export function createAgentHost({
  agent,
  agentEndpoints,
  common,
  storage,
  observe,
  worker,
  channels
}: AgentHostOptions): AgentHost {
  const traced = createOperationTracer(observe)
  return {
    ...common,
    forPrincipal(principal: AgentPrincipal): ScopedAgentHost {
      textId.parse(principal.subject)

      const scope = [...new Set(principal.endpointIds)].filter((id) =>
        agentEndpoints.some((e) => e.id === id)
      )

      return {
        media: createAgentMedia(storage, agent, scope, worker),
        listPending: async (count) =>
          storage.listPending({
            agent,
            endpointIds: scope,
            limit: limit(count)
          }),
        claim: async (requestId, claimKey) =>
          traced('claim', async () =>
            storage.claimRequest({
              requestId: textId.parse(requestId),
              endpointIds: scope,
              agent,
              claimKey: textId.parse(claimKey),
              claimToken: crypto.randomUUID(),
              now: Date.now()
            })
          ),
        async complete(input) {
          textId.parse(input.requestId)
          textId.parse(input.claimToken)
          textId.parse(input.resultId)
          boundedText(
            input.text,
            worker.maxTextBytes,
            !input.attachments?.length
          )
          const request = await storage.getInbound(input.requestId)
          if (
            !request ||
            !scope.includes(request.snapshot.endpoint.id) ||
            request.snapshot.endpoint.agent !== agent
          ) {
            return { status: 'not_found' }
          }
          if (
            input.attachments &&
            !authorizedRequest(request, agent, scope, input.claimToken)
          ) {
            return { status: 'unauthorized' }
          }

          const media = await completionMedia(
            storage,
            input.requestId,
            input.attachments,
            worker
          )

          const channelPlugin = channels.get(request.snapshot.target.accountId)
          if (!channelPlugin) {
            throw new CoreError('channel_plugin_missing')
          }
          if (
            media.some(
              (item) =>
                !channelPlugin.capabilities.media?.send.includes(
                  item.reference.kind
                )
            )
          ) {
            throw new CoreError('media_not_supported')
          }
          const deliveryId = crypto.randomUUID()
          const now = Date.now()

          const chunks = (
            input.text
              ? chunkText(
                  input.text,
                  channelPlugin.capabilities.maxTextLength,
                  channelPlugin.capabilities.lengthUnit
                )
              : []
          ).map((text, index) => ({
            text,
            idempotencyKey: `${deliveryId}:${index}`,
            state: null as Json
          }))

          const deliveryChunks = [
            ...chunks,
            ...media.map((item, index) => ({
              text: '',
              media: item.reference,
              idempotencyKey: `${deliveryId}:${chunks.length + index}`,
              state: null as Json
            }))
          ]

          const result = await traced(
            'complete',
            async () =>
              storage.completeAndEnqueue({
                requestId: input.requestId,
                endpointIds: scope,
                agent,
                claimToken: input.claimToken,
                result: {
                  resultId: input.resultId,
                  text: input.text,
                  ...(media.length > 0
                    ? { attachments: media.map((item) => item.reference) }
                    : {}),
                  completedAt: now
                },
                outbound: {
                  deliveryId,
                  requestId: input.requestId,
                  resultId: input.resultId,
                  target: jsonSnapshot(request.snapshot.target),
                  chunks: deliveryChunks,
                  currentChunk: 0,
                  receipts: [],
                  status: 'pending',
                  version: 1,
                  attempts: 0,
                  dueAt: now,
                  createdAt: now,
                  ...(request.snapshot.trace
                    ? { trace: request.snapshot.trace }
                    : {})
                }
              }),
            request.snapshot.trace
          )

          if (result.status === 'completed' && !result.replay) {
            observe.record(
              'relanox_result_duration_seconds',
              Math.max(0, (now - request.snapshot.acceptedAt) / 1000),
              { agent }
            )
          }
          observe.log('info', 'complete.completed', {
            plugin: 'core',
            requestId: input.requestId,
            outcome: result.status === 'completed' ? 'ok' : result.status
          })
          return result
        },
        fail: async (input) =>
          traced('fail', async () =>
            storage.fail({
              requestId: textId.parse(input.requestId),
              endpointIds: scope,
              agent,
              claimToken: textId.parse(input.claimToken),
              errorCode: z
                .string()
                .regex(/^[a-zA-Z0-9_-]{1,128}$/u)
                .parse(input.errorCode),
              now: Date.now()
            })
          )
      }
    }
  }
}
