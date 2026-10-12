import { name, subscriptionSchema } from './protocol.js'
import type { SubscriptionStore } from './subscriptions.js'

/** Subscription state belongs to the authenticated endpoint. */
export async function connectionStatus(
  endpointId: string,
  subscriptions: SubscriptionStore
): Promise<Record<string, unknown>> {
  const entries = await subscriptions.activeEntries(endpointId)
  const now = Date.now()

  const activeSubscriptions = entries.filter((entry) => {
    const sub = subscriptionSchema.parse(entry.value)
    return (
      sub.owner === endpointId &&
      sub.endpointId === endpointId &&
      sub.expiresAt > now
    )
  }).length

  return { endpointId, eventName: name, activeSubscriptions }
}
