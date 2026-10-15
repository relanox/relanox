import type { EndpointConfig } from '@relanox/sdk'
import { name, subscriptionSchema } from './protocol.js'
import { endpointFingerprint } from './subscriptions.js'
import type { SubscriptionStore } from './subscriptions.js'

/** Subscription state belongs to the authenticated endpoint. */
export async function connectionStatus(
  endpoint: EndpointConfig,
  subscriptions: SubscriptionStore
): Promise<Record<string, unknown>> {
  const entries = await subscriptions.activeEntries(endpoint.id)
  const now = Date.now()
  const ownerConfig = endpointFingerprint(endpoint)

  const activeSubscriptions = entries.filter((entry) => {
    const sub = subscriptionSchema.parse(entry.value)
    return (
      sub.owner === endpoint.id &&
      sub.endpointId === endpoint.id &&
      sub.ownerConfig === ownerConfig &&
      sub.expiresAt > now
    )
  }).length

  return { endpointId: endpoint.id, eventName: name, activeSubscriptions }
}
