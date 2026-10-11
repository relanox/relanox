import { projectAgentRequest } from '@relanox/agent-mcp'
import type { AgentHost, AgentPlugin, DispatchResult } from '@relanox/sdk'
import { CallbackError, callbackUrl, postCallback } from './callback.js'
import type { DotConfig } from './config.js'
import { name, subscriptionSchema } from './protocol.js'
import { signedHeaders } from './subscriptions.js'
import type { SubscriptionStore } from './subscriptions.js'

export function createDispatch(
  state: AgentHost['state'],
  configured: ReadonlyMap<string, DotConfig>,
  subscriptionStore: SubscriptionStore
): AgentPlugin<DotConfig>['dispatch'] {
  return async ({ request, signal }): Promise<DispatchResult> => {
    if (!configured.has(request.endpoint.id)) {
      return { status: 'rejected', errorCode: 'dot_endpoint_revoked' }
    }
    const now = Date.now()

    const subscriptions = (
      await subscriptionStore.activeEntries(request.endpoint.id)
    )
      .map((entry) => ({ entry, sub: subscriptionSchema.parse(entry.value) }))
      .filter(
        ({ sub }) =>
          sub.owner === request.endpoint.id &&
          sub.endpointId === request.endpoint.id &&
          sub.expiresAt > now
      )

    if (subscriptions.length === 0) {
      return { status: 'retryable', errorCode: 'dot_no_active_subscription' }
    }
    const eventId = `evt_${request.requestId}`

    const body = JSON.stringify({
      eventId,
      name,
      timestamp: new Date(request.acceptedAt).toISOString(),
      data: projectAgentRequest(request),
      cursor: null
    })

    if (Buffer.byteLength(body) > 262_144) {
      return { status: 'rejected', errorCode: 'dot_event_too_large' }
    }
    let outcome: DispatchResult = { status: 'accepted' }
    const priority = { accepted: 0, rejected: 1, retryable: 2, unknown: 3 }

    const merge = (next: DispatchResult): void => {
      if (priority[next.status] > priority[outcome.status]) {
        outcome = next
      }
    }

    for (const { sub, entry } of subscriptions) {
      try {
        // Recheck the native callback destination for persisted subscriptions.
        callbackUrl(sub.url)

        const response = await postCallback(
          sub.url,
          body,
          signedHeaders(sub, body, eventId),
          signal,
          'headers'
        )

        if (response.status >= 200 && response.status < 300) {
          continue
        }
        if (response.status === 408) {
          merge({ status: 'unknown', errorCode: 'dot_callback_http_408' })
        } else if (
          response.status === 410 ||
          response.status === 413 ||
          (response.status >= 300 &&
            response.status < 500 &&
            response.status !== 429)
        ) {
          if (response.status === 410) {
            // Cannot delete a concurrently refreshed subscription.
            await state.delete(entry.key, entry.version)
          }
          merge({
            status: 'rejected',
            errorCode: `dot_callback_http_${response.status}`
          })
        } else {
          merge({
            status: 'retryable',
            errorCode: `dot_callback_http_${response.status}`
          })
        }
      } catch (error) {
        merge(
          error instanceof CallbackError &&
            error.reason === 'forbidden_destination'
            ? { status: 'rejected', errorCode: 'dot_callback_forbidden' }
            : { status: 'unknown', errorCode: 'dot_callback_uncertain' }
        )
      }
    }
    return outcome
  }
}
