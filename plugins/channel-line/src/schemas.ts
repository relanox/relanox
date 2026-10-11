import { z } from "zod";
import { platformIdSchema } from "./config.js";

export const eventSchema = z.object({
  type: z.string(),
  webhookEventId: platformIdSchema.optional(),
  timestamp: z.number().int().nonnegative().optional(),
  source: z
    .object({
      type: z.enum(["user", "group", "room"]),
      userId: platformIdSchema.optional(),
      groupId: platformIdSchema.optional(),
      roomId: platformIdSchema.optional(),
    })
    .optional(),
  message: z
    .object({
      id: platformIdSchema,
      type: z.string(),
      text: z.string().optional(),
      fileName: z.string().optional(),
      fileSize: z.number().int().nonnegative().optional(),
      duration: z.number().int().positive().optional(),
      contentProvider: z
        .object({ type: z.enum(["line", "external"]), originalContentUrl: z.url().optional() })
        .optional(),
    })
    .optional(),
});

export const webhookSchema = z.object({
  destination: platformIdSchema,
  events: z.array(eventSchema),
});

export const targetSchema = z.strictObject({
  destination: platformIdSchema,
  sourceType: z.enum(["user", "group", "room"]),
  botId: platformIdSchema,
  apiBaseUrl: z.string(),
});

export const retrySchema = z.strictObject({
  retryKey: z.uuid(),
  startedAt: z.number().int().nonnegative(),
});

export const receiptSchema = z.object({
  sentMessages: z.array(z.object({ id: platformIdSchema })).optional(),
});
