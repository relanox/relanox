import { channelAddressSchema } from './status.js'
import { z } from 'zod'
import type { InboundSnapshot } from '@relanox/sdk'

export type AgentRequestPayload = Pick<
  InboundSnapshot,
  'text' | 'context' | 'attachments'
> & {
  readonly source: {
    readonly channel: InboundSnapshot['channel']
    readonly senderId: string
  }
}

export function projectAgentRequest(
  request: InboundSnapshot
): AgentRequestPayload {
  return {
    text: request.text,
    context: request.context,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    source: {
      channel: request.channel,
      senderId: request.senderId
    }
  }
}

export const agentRequestSchema = z.strictObject({
  text: z.string(),
  context: z.json(),
  attachments: z
    .array(
      z.strictObject({
        id: z.string(),
        kind: z.enum(['image', 'audio', 'video', 'file']),
        mimeType: z.string(),
        fileName: z.string(),
        size: z.number().int().nonnegative(),
        sha256: z.string(),
        durationMs: z.number().int().positive().optional(),
        previewMediaId: z.string().optional()
      })
    )
    .optional(),
  source: z.strictObject({
    channel: channelAddressSchema,
    senderId: z.string()
  })
})
