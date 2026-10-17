import { z } from 'zod'
import { contentSchema } from './media.js'

export const messageSchema = z.object({
  msgId: z.string().min(1),
  conversationType: z.enum(['1', '2']),
  conversationId: z.string().min(1),
  senderId: z.string().min(1),
  senderStaffId: z.string().optional(),
  chatbotUserId: z.string().optional(),
  robotCode: z.string().min(1),
  isInAtList: z.boolean().optional(),
  msgtype: z.string(),
  content: contentSchema.optional(),
  text: z.object({ content: z.string().min(1) }).optional()
})

export const scopeSchema = z
  .object({
    clientId: z.string().min(1),
    robotCode: z.string().min(1),
    apiBase: z.url(),
    uploadBase: z.url().optional()
  })
  .strict()

export const targetSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('single'),
      staffId: z.string().min(1),
      scope: scopeSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('group'),
      openConversationId: z.string().min(1),
      scope: scopeSchema
    })
    .strict()
])
