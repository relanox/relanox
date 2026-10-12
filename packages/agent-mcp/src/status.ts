import { z } from 'zod'

export const channelAddressSchema = z.strictObject({
  id: z.string(),
  platform: z.enum([
    'telegram',
    'discord',
    'slack',
    'feishu',
    'wecom',
    'dingtalk',
    'qq',
    'msteams',
    'whatsapp',
    'matrix',
    'googlechat',
    'line',
    'mattermost',
    'signal',
    'irc'
  ]),
  accountId: z.string(),
  chatId: z.string(),
  threadId: z.string().optional()
})

export const statusSchema = z.strictObject({
  channels: z.array(
    z.strictObject({
      channel: channelAddressSchema,
      connection: z.enum(['connected', 'disconnected', 'degraded']),
      send: z.union([
        z.strictObject({ status: z.literal('available') }),
        z.strictObject({ status: z.literal('unavailable'), reason: z.string() })
      ]),
      media: z.array(z.enum(['image', 'audio', 'video', 'file'])),
      maxTextLength: z.number().int().positive(),
      lengthUnit: z.enum(['utf16', 'codepoint', 'utf8']),
      maxTextLengthPerMessage: z.number().int().positive().optional(),
      maxChunksPerMessage: z.number().int().positive().optional(),
      maxAttachments: z.number().int().nonnegative().optional()
    })
  ),
  mediaLimits: z.strictObject({
    maxBytes: z.number().int().nonnegative(),
    maxTotalBytes: z.number().int().nonnegative(),
    maxAttachments: z.number().int().nonnegative()
  }),
  delivery: z
    .strictObject({
      id: z.string(),
      channel: z.string(),
      status: z.enum(['pending', 'sent', 'rejected', 'unknown']),
      errorCode: z.string().optional()
    })
    .optional(),
  connection: z
    .strictObject({
      endpointId: z.string(),
      eventName: z.literal('relanox.message_available'),
      activeSubscriptions: z.number().int().nonnegative()
    })
    .optional()
})
