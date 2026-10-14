import { channelAddressSchema } from './status.js'
import { z } from 'zod'
import type { InboundSnapshot, AgentMessage } from '@relanox/sdk'

export type AgentRequestPayload = Pick<
  AgentMessage,
  'text' | 'context' | 'attachments' | 'transcriptions'
> & {
  readonly source: {
    readonly channel: InboundSnapshot['channel']
    readonly senderId: string
  }
}

export function projectAgentRequest(
  request: Pick<
    AgentMessage,
    | 'text'
    | 'context'
    | 'attachments'
    | 'channel'
    | 'senderId'
    | 'transcriptions'
  >
): AgentRequestPayload {
  return {
    text: request.text,
    context: request.context,
    ...(request.transcriptions
      ? { transcriptions: request.transcriptions }
      : {}),
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
  transcriptions: z
    .array(
      z.discriminatedUnion('status', [
        z.strictObject({
          mediaId: z.string(),
          status: z.literal('transcribed'),
          text: z.string()
        }),
        z.strictObject({
          mediaId: z.string(),
          status: z.literal('failed'),
          errorCode: z.string()
        })
      ])
    )
    .optional(),
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
