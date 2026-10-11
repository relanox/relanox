import type { InboundSnapshot } from '@relanox/sdk'

export type AgentRequestPayload = Pick<
  InboundSnapshot,
  'requestId' | 'text' | 'context' | 'attachments'
> & {
  readonly source: Pick<InboundSnapshot['source'], 'channel' | 'eventId'>
}

export function projectAgentRequest(
  request: InboundSnapshot
): AgentRequestPayload {
  return {
    requestId: request.requestId,
    text: request.text,
    context: request.context,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    source: {
      channel: request.source.channel,
      eventId: request.source.eventId
    }
  }
}
