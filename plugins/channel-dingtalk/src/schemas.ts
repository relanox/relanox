import { z } from "zod";

export const streamSchema = z.object({
  type: z.enum(["SYSTEM", "CALLBACK", "EVENT"]),
  headers: z.object({
    topic: z.string(),
    messageId: z.string().optional(),
    contentType: z.string().optional(),
  }),
  data: z.string(),
});
export const messageSchema = z.object({
  msgId: z.string().min(1),
  conversationType: z.enum(["1", "2"]),
  conversationId: z.string().min(1),
  senderId: z.string().min(1),
  senderStaffId: z.string().min(1).optional(),
  chatbotUserId: z.string().optional(),
  robotCode: z.string().min(1),
  isInAtList: z.boolean().optional(),
  msgtype: z.string(),
  text: z.object({ content: z.string().min(1) }).optional(),
});
export const tokenSchema = z.object({
  accessToken: z.string().min(1),
  expireIn: z.number().int().positive(),
});
export const scopeSchema = z
  .object({ clientId: z.string().min(1), robotCode: z.string().min(1), apiBase: z.url() })
  .strict();
export const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("single"), staffId: z.string().min(1), scope: scopeSchema }).strict(),
  z
    .object({ type: z.literal("group"), openConversationId: z.string().min(1), scope: scopeSchema })
    .strict(),
]);
export const sendResponse = z.object({
  processQueryKey: z.string().min(1),
  invalidStaffIdList: z.array(z.string()).optional(),
  flowControlledStaffIdList: z.array(z.string()).optional(),
});

export const streamOpenResponseSchema = z.object({ endpoint: z.url(), ticket: z.string().min(1) });
