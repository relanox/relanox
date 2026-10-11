import { z } from "zod";
import { id } from "./transport.js";

export const targetSchema = z.object({ teamId: id, appId: id, botId: id, apiBaseUrl: z.string() });
export const envelopeSchema = z.looseObject({
  type: z.string(),
  team_id: id.optional(),
  api_app_id: id.optional(),
  event_id: id.optional(),
  event: z.unknown().optional(),
  challenge: id.optional(),
});
export const messageSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  bot_id: id.optional(),
  user: id.optional(),
  channel: id.optional(),
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
