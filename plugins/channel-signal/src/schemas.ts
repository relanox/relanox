import { z } from 'zod'
import { platformIdSchema } from './config.js'

export const attachmentSchema = z.object({
  id: z.string().min(1).max(1024).nullable(),
  contentType: z.string().min(1).max(128),
  filename: z.string().min(1).max(255).nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional()
})

const messageSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  message: z.string().nullable().optional(),
  attachments: z.array(attachmentSchema).max(10).default([]),
  groupInfo: z.object({ groupId: platformIdSchema }).nullable().optional(),
  viewOnce: z.boolean().nullable().optional()
})

const envelopeSchema = z.object({
  source: platformIdSchema.nullable().optional(),
  sourceNumber: platformIdSchema.nullable().optional(),
  sourceUuid: platformIdSchema.nullable().optional(),
  timestamp: z.number().int().nonnegative(),
  dataMessage: messageSchema.nullable().optional()
})

export const receiveSchema = z.object({
  envelope: envelopeSchema.optional(),
  exception: z
    .object({ message: z.string().nullable(), type: z.string() })
    .optional(),
  account: platformIdSchema.optional()
})

export const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('direct'),
    recipient: platformIdSchema,
    serviceUrl: z.string(),
    account: platformIdSchema
  }),
  z.strictObject({
    kind: z.literal('group'),
    groupId: platformIdSchema,
    serviceUrl: z.string(),
    account: platformIdSchema
  })
])

export const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string(),
  result: z
    .object({
      timestamp: z.number().int().nonnegative(),
      results: z
        .array(z.object({ type: z.string() }))
        .min(1)
        .optional()
    })
    .optional(),
  error: z.object({ code: z.number().int() }).optional()
})

export const eventCursorSchema = z
  .string()
  .max(1024)
  .regex(/^[^\r\n\0]*$/u)
