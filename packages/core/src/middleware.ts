import type {
  Json,
  DispatchInput,
  InboundRecord,
  MessageMiddleware,
  MiddlewareMessage,
  MiddlewarePlan
} from '@relanox/sdk'
import { z } from 'zod'
import { jsonSnapshot } from './json.js'

/** Project persisted generic outputs identically for notifications and authenticated reads. */
export function preparedRequest(
  record: InboundRecord
): DispatchInput['request'] {
  let text = record.snapshot.text
  const extensions: Record<string, Json> = {}
  for (const result of record.preparation ?? []) {
    if (result.status === 'completed' && result.output !== null) {
      text = result.output.text
      if (result.output.data !== undefined) {
        extensions[result.id] = result.output.data
      }
    }
  }
  return {
    ...record.snapshot,
    text,
    ...(Object.keys(extensions).length > 0 ? { extensions } : {})
  }
}

export function middlewareMessage(
  request: DispatchInput['request']
): MiddlewareMessage {
  return jsonSnapshot({
    requestId: request.requestId,
    acceptedAt: request.acceptedAt,
    channel: request.channel,
    senderId: request.senderId,
    text: request.text,
    context: request.context,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(request.extensions ? { extensions: request.extensions } : {})
  })
}

/** A broken selector cannot prevent an authorized original message from being saved. */
export function planMiddleware(
  middleware: readonly MessageMiddleware[],
  request: DispatchInput['request']
): readonly MiddlewarePlan[] {
  const plans: MiddlewarePlan[] = []
  for (const item of middleware) {
    try {
      const options = item.plan(middlewareMessage(request))
      if (options !== undefined && JSON.stringify(options).length <= 65_536) {
        plans.push({
          id: item.id,
          options: jsonSnapshot(z.json().parse(options))
        })
      }
    } catch {
      // Selection is optional; no external processing has started yet.
    }
  }
  return plans
}
