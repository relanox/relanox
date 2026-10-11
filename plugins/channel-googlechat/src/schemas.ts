import { z } from "zod";
import { identifier } from "./io.js";

export const serviceSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z.string().min(1).max(16_384),
});
const spaceId = z.string().regex(/^spaces\/[A-Za-z0-9_-]+$/u);
const threadId = z.string().regex(/^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/u);
const messageSchema = z.object({
  name: identifier,
  text: z.string().optional(),
  argumentText: z.string().optional(),
  sender: z.object({ name: identifier, type: z.string().optional() }),
  thread: z.object({ name: threadId }).optional(),
});
export const eventSchema = z.object({
  type: z.string(),
  space: z.object({ name: spaceId }).optional(),
  message: messageSchema.optional(),
});
export const targetSchema = z.strictObject({
  space: spaceId,
  thread: threadId.optional(),
  scope: z.strictObject({ clientEmail: z.email(), apiBase: z.url() }),
});
export const receiptSchema = z.object({ name: identifier });
