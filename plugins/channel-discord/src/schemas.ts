import { z } from "zod";
import { id } from "./transport.js";

export const targetSchema = z.object({ botId: id, apiBaseUrl: z.string() });
export const packetSchema = z.looseObject({
  op: z.number().int(),
  d: z.unknown().optional(),
  s: z.number().int().nullable().optional(),
  t: z.string().nullable().optional(),
});
export const sessionSchema = z.object({
  session_id: id,
  resume_gateway_url: z.string(),
  seq: z.number().int(),
  botId: id,
  apiBaseUrl: z.string(),
  gatewayUrl: z.string(),
});
export const readySchema = z.looseObject({
  session_id: id,
  resume_gateway_url: z.string(),
  user: z.looseObject({ id }),
});
export const messageSchema = z.looseObject({
  id,
  channel_id: id,
  guild_id: id.optional(),
  content: z.string().max(1_048_576),
  author: z.looseObject({ id, bot: z.boolean().optional() }),
  webhook_id: id.optional(),
  type: z.number().int(),
});
