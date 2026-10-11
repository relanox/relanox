import { z } from "zod";
import { platformIdSchema } from "./config.js";

export const targetSchema = z.object({ botId: platformIdSchema, apiBaseUrl: z.string() });
export const packetSchema = z.looseObject({
  op: z.number().int(),
  d: z.unknown().optional(),
  s: z.number().int().nullable().optional(),
  t: z.string().nullable().optional(),
});
export const sessionSchema = z.object({
  session_id: platformIdSchema,
  resume_gateway_url: z.string(),
  seq: z.number().int(),
  botId: platformIdSchema,
  apiBaseUrl: z.string(),
  gatewayUrl: z.string(),
});
export const readySchema = z.looseObject({
  session_id: platformIdSchema,
  resume_gateway_url: z.string(),
  user: z.looseObject({ id: platformIdSchema }),
});
export const messageSchema = z.looseObject({
  id: platformIdSchema,
  channel_id: platformIdSchema,
  guild_id: platformIdSchema.optional(),
  content: z.string().max(1_048_576),
  author: z.looseObject({ id: platformIdSchema, bot: z.boolean().optional() }),
  webhook_id: platformIdSchema.optional(),
  type: z.number().int(),
});

export const rateLimitResponseSchema = z.looseObject({ retry_after: z.number().nonnegative() });

export const sendResponseSchema = z.looseObject({ id: platformIdSchema });

export const channelInfoSchema = z.looseObject({
  id: platformIdSchema,
  type: z.number().int(),
  parent_id: platformIdSchema.nullable().optional(),
});

export const helloEventSchema = z.object({
  heartbeat_interval: z.number().int().min(10).max(300_000),
});
