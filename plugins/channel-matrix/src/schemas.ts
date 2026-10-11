import { z } from "zod";
import { identifier } from "./config.js";

const relationSchema = z.object({
  rel_type: z.string().optional(),
  event_id: identifier.optional(),
  "m.in_reply_to": z.object({ event_id: identifier }).optional(),
});
export const eventSchema = z.object({
  event_id: identifier,
  sender: identifier,
  type: identifier,
  origin_server_ts: z.number().int().nonnegative().optional(),
  content: z.record(z.string(), z.unknown()),
});
const timelineSchema = z.object({
  events: z.array(eventSchema),
  limited: z.boolean().optional(),
});
export const syncSchema = z.object({
  next_batch: identifier,
  rooms: z
    .object({
      join: z.record(z.string(), z.object({ timeline: timelineSchema.optional() })).optional(),
    })
    .optional(),
});
export const textSchema = z.object({
  msgtype: z.literal("m.text"),
  body: z.string().min(1),
  "m.relates_to": relationSchema.optional(),
});

export const targetSchema = z.strictObject({ homeserver: z.string(), userId: identifier });
