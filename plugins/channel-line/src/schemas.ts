import { z } from "zod";
import { identifier } from "./io.js";

export const eventSchema = z.object({
  type: z.string(),
  webhookEventId: identifier.optional(),
  timestamp: z.number().int().nonnegative().optional(),
  source: z
    .object({
      type: z.enum(["user", "group", "room"]),
      userId: identifier.optional(),
      groupId: identifier.optional(),
      roomId: identifier.optional(),
    })
    .optional(),
  message: z.object({ id: identifier, type: z.string(), text: z.string().optional() }).optional(),
});
export const webhookSchema = z.object({ destination: identifier, events: z.array(eventSchema) });
export const targetSchema = z.strictObject({
  destination: identifier,
  sourceType: z.enum(["user", "group", "room"]),
  botId: identifier,
  apiBaseUrl: z.string(),
});
export const retrySchema = z.strictObject({
  retryKey: z.uuid(),
  startedAt: z.number().int().nonnegative(),
});
export const receiptSchema = z.object({
  sentMessages: z.array(z.object({ id: identifier })).optional(),
});
