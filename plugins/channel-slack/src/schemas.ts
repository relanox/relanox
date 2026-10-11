import { z } from "zod";
import { platformIdSchema } from "./config.js";

export const targetSchema = z.object({
  teamId: platformIdSchema,
  appId: platformIdSchema,
  botId: platformIdSchema,
  apiBaseUrl: z.string(),
});
export const envelopeSchema = z.looseObject({
  type: z.string(),
  team_id: platformIdSchema.optional(),
  api_app_id: platformIdSchema.optional(),
  event_id: platformIdSchema.optional(),
  event: z.unknown().optional(),
  challenge: platformIdSchema.optional(),
});
export const messageSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  bot_id: platformIdSchema.optional(),
  user: platformIdSchema.optional(),
  channel: platformIdSchema.optional(),
  ts: z
    .string()
    .regex(/^\d+\.\d+$/u)
    .optional(),
  thread_ts: z
    .string()
    .regex(/^\d+\.\d+$/u)
    .optional(),
  text: z.string().max(1_048_576).optional(),
});

export const socketOpenResponseSchema = z.looseObject({
  ok: z.boolean(),
  url: z.string().optional(),
});

export const socketFrameSchema = z.looseObject({
  type: z.string(),
  envelope_id: platformIdSchema.optional(),
  payload: z.unknown().optional(),
});

export const sendResponseSchema = z.looseObject({
  ok: z.boolean(),
  ts: platformIdSchema.optional(),
  error: z.string().optional(),
});
