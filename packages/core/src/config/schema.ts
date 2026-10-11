import { z } from 'zod'

export const channels = [
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
] as const

// IDs are local configuration references; platform identifiers remain opaque strings.
const configIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
const platformIdSchema = z.string().min(1).max(1024)
const senderAllowlistSchema = z.array(platformIdSchema).min(1)

const accountSchema = z.strictObject({
  id: configIdSchema,
  channel: z.enum(channels),
  config: z.json(),
  allowedSenders: senderAllowlistSchema
})

const endpointSchema = z.strictObject({
  id: configIdSchema,
  agent: z.enum(['dot', 'grok']),
  config: z.json()
})

const bindingSchema = z.strictObject({
  accountId: configIdSchema,
  chatId: platformIdSchema,
  threadId: platformIdSchema.optional(),
  endpointId: configIdSchema,
  allowedSenders: senderAllowlistSchema.optional()
})

/** Shape validation is separate from references between accounts, endpoints, and bindings. */
export const configShapeSchema = z.strictObject({
  accounts: z.array(accountSchema),
  endpoints: z.array(endpointSchema),
  bindings: z.array(bindingSchema),
  storage: z.strictObject({
    plugin: z.enum(['sqlite', 'postgres']),
    config: z.json()
  }),
  observability: z.strictObject({
    plugin: z.enum(['standard', 'none']),
    config: z.json()
  })
})
